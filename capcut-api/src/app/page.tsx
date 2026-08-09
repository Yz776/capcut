'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Flame, Sparkles, Music, Play, Heart, MessageCircle,
  Share2, Star, Eye, Repeat, Download, Image as ImageIcon,
  Film, User, Hash, Clock, Layers, Camera, Video, Maximize,
  ChevronRight, Shuffle, Copy, Check, Zap, Headphones, Clapperboard,
  TrendingUp, ExternalLink, Loader2, AlertCircle, Wifi, Server,
  RefreshCw, Grid3x3, List as ListIcon, ArrowLeft, Tag,
  Search, X,
} from 'lucide-react'

// ──────────────────────────────────────────────────────────────
// FF user screenshots (dipakai sebagai "Your Photos" placeholder)
// ──────────────────────────────────────────────────────────────
const FF_PHOTOS = [
  '/uploads/freefire-1.jpg',
  '/uploads/freefire-2.jpg',
  '/uploads/freefire-3.jpg',
  '/uploads/freefire-4.jpg',
  '/uploads/freefire-5.jpg',
  '/uploads/freefire-6.jpg',
  '/uploads/freefire-7.jpg',
  '/uploads/freefire-8.jpg',
  '/uploads/freefire-9.jpg',
]

// ──────────────────────────────────────────────────────────────
// Types — sesuai dengan output /api/capcut/list
// ──────────────────────────────────────────────────────────────
interface CapCutTemplate {
  id: string
  title: string
  desc: string
  short: string
  author: string
  username: string
  author_avatar: string
  cover_url: string
  video_url: string
  duration_s: number
  fragment: number
  width: number
  height: number
  ratio: string
  resolution: string
  stats: {
    like: number
    usage: number
    view: number
    favorite: number
    comment: number
    share: number
  }
  share_url: string
  template_url: string
  upload_date: number
}

interface ApiResponse {
  ok: boolean
  real: boolean
  source: string
  count?: number
  categories?: string[]
  templates?: CapCutTemplate[]
  error?: string
  tried?: Array<{ url: string; status: number; ok: boolean; error?: string; found?: number }>
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function formatCount(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return (v >= 10 ? Math.floor(v) : Math.floor(v * 10) / 10) + 'M'
  }
  if (n >= 1_000) {
    const v = n / 1_000
    return (v >= 100 ? Math.floor(v) : Math.floor(v * 10) / 10) + 'K'
  }
  return String(n)
}

function timeAgo(unix: number): string {
  if (!unix) return ''
  const diff = Math.floor(Date.now() / 1000 - unix)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`
  return `${Math.floor(diff / 2592000)}mo ago`
}

// ──────────────────────────────────────────────────────────────
// Style presets (untuk gradient/glow UI, bukan data template)
// ──────────────────────────────────────────────────────────────
type StyleKey = 'viral' | 'dj' | 'aesthetic' | 'cinematic' | 'trending' | 'jj'

const STYLES: Record<StyleKey, {
  label: string
  gradient: string
  glow: string
  chipColor: string
}> = {
  jj: {
    label: 'JJ Signature',
    gradient: 'from-purple-600 via-fuchsia-600 to-pink-600',
    glow: 'shadow-purple-500/50',
    chipColor: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  },
  viral: {
    label: 'Viral FYP',
    gradient: 'from-orange-500 via-red-500 to-rose-600',
    glow: 'shadow-orange-500/50',
    chipColor: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  },
  dj: {
    label: 'DJ Kane',
    gradient: 'from-cyan-500 via-blue-600 to-indigo-700',
    glow: 'shadow-cyan-500/50',
    chipColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  },
  aesthetic: {
    label: 'Aesthetic',
    gradient: 'from-pink-400 via-rose-400 to-amber-300',
    glow: 'shadow-pink-400/50',
    chipColor: 'bg-pink-400/20 text-pink-200 border-pink-400/40',
  },
  cinematic: {
    label: 'Cinematic',
    gradient: 'from-slate-600 via-gray-700 to-zinc-800',
    glow: 'shadow-slate-500/50',
    chipColor: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  },
  trending: {
    label: 'Trending',
    gradient: 'from-yellow-400 via-amber-500 to-orange-600',
    glow: 'shadow-yellow-500/50',
    chipColor: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40',
  },
}

const styleKeys = Object.keys(STYLES) as StyleKey[]

// ──────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────
function StatChip({ icon: Icon, label, value, color }: {
  icon: React.ElementType
  label: string
  value: string | number
  color: string
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-black/40 border border-white/5 px-3 py-2">
      <Icon className={`h-4 w-4 ${color}`} />
      <div className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wider text-white/40">{label}</span>
        <span className="text-sm font-bold text-white tabular-nums">{value}</span>
      </div>
    </div>
  )
}

function FieldRow({ icon: Icon, label, value, accent }: {
  icon: React.ElementType
  label: string
  value: string
  accent: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex items-center gap-2 text-white/60">
        <Icon className={`h-3.5 w-3.5 ${accent}`} />
        <span className="text-xs uppercase tracking-wider">{label}</span>
      </div>
      <span className="text-sm font-semibold text-white text-right truncate max-w-[60%]">{value}</span>
    </div>
  )
}

function AtSign(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  )
}
function FolderId(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <circle cx="14" cy="13" r="1.5" fill="currentColor" />
    </svg>
  )
}

function TemplateCard({ tpl, style, onPick, index }: {
  tpl: CapCutTemplate
  style: StyleKey
  onPick: (t: CapCutTemplate) => void
  index: number
}) {
  const preset = STYLES[style]
  return (
    <motion.button
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5) }}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.97 }}
      onClick={() => onPick(tpl)}
      className="group relative overflow-hidden rounded-2xl border border-white/10 bg-zinc-900 text-left"
    >
      <div className="relative aspect-[9/16] overflow-hidden bg-black">
        {tpl.cover_url ? (
          <img
            src={tpl.cover_url}
            alt={tpl.title}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-800 to-zinc-900">
            <ImageIcon className="h-8 w-8 text-white/20" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-transparent" />

        {/* Top badges */}
        <div className="absolute top-2 left-2 flex items-center gap-1">
          <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-bold backdrop-blur-sm ${preset.chipColor}`}>
            {tpl.ratio}
          </span>
        </div>
        <div className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 backdrop-blur-sm">
          <Clock className="h-2.5 w-2.5 text-white/70" />
          <span className="text-[10px] font-bold text-white/90">{tpl.duration_s}s</span>
        </div>

        {/* Play button overlay */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <div className={`flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br ${preset.gradient} shadow-xl`}>
            <Play className="h-5 w-5 fill-white text-white ml-0.5" />
          </div>
        </div>

        {/* Bottom info */}
        <div className="absolute bottom-2 left-2 right-2">
          <p className="text-xs font-bold text-white line-clamp-2 mb-1 drop-shadow">{tpl.title}</p>
          <div className="flex items-center gap-2 text-[10px] text-white/70">
            <span className="flex items-center gap-0.5">
              <Repeat className="h-2.5 w-2.5" />
              {formatCount(tpl.stats.usage)}
            </span>
            <span className="flex items-center gap-0.5">
              <Heart className="h-2.5 w-2.5" />
              {formatCount(tpl.stats.like)}
            </span>
            {tpl.fragment > 0 && (
              <span className="flex items-center gap-0.5">
                <Layers className="h-2.5 w-2.5" />
                {tpl.fragment}
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.button>
  )
}

function DetailView({ tpl, style, onBack, onCopy }: {
  tpl: CapCutTemplate
  style: StyleKey
  onBack: () => void
  onCopy: (text: string) => void
}) {
  const preset = STYLES[style]
  const [showVideo, setShowVideo] = useState(false)

  // FF photos dipakai sebagai "Your Photos" placeholder (slot upload)
  const photoSlots = Math.min(tpl.fragment || 3, 9)
  const ffPhotos = FF_PHOTOS.slice(0, photoSlots)

  const cardText = `${preset.label} *JJ Capcut - Detail* [REAL CAPCUT DATA]
───────────────────
📌 Judul     : ${tpl.title}
🏷️ Short     : ${tpl.short}
👤 Source    : CapCut Server
🆔 TemplateID: ${tpl.id}
🌐 URL       : ${tpl.share_url}
───────────────────
⏱️ Durasi    : ${tpl.duration_s}s
🖼️ Fragment  : ${tpl.fragment}
📐 Resolusi  : ${tpl.resolution}
📊 Ratio     : ${tpl.ratio}
───────────────────
📊 Real Stats:
🔥 Usage     : ${formatCount(tpl.stats.usage)}
❤️ Like      : ${formatCount(tpl.stats.like)}
▶️ View      : ${formatCount(tpl.stats.view)}
───────────────────
📸 Your Photos (FF screenshots): ${photoSlots} slot
Source: api.capcut.com via /api/capcut/list`

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-white/60 hover:text-white transition"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to templates
      </button>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        {/* Left: Video / Cover preview */}
        <div className="space-y-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            className={`relative aspect-[9/16] sm:aspect-video lg:aspect-[9/16] overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl ${preset.glow} mx-auto max-w-[320px] lg:max-w-none`}
          >
            {showVideo && tpl.video_url ? (
              <video
                src={tpl.video_url}
                poster={tpl.cover_url}
                controls
                autoPlay
                loop
                className="h-full w-full object-cover"
              />
            ) : (
              <>
                {tpl.cover_url && (
                  <img src={tpl.cover_url} alt={tpl.title} className="h-full w-full object-cover" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-transparent" />
                <button
                  onClick={() => setShowVideo(true)}
                  className="absolute inset-0 flex items-center justify-center"
                  aria-label="Play video"
                >
                  <motion.div
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.95 }}
                    className={`flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br ${preset.gradient} shadow-xl`}
                  >
                    <Play className="h-7 w-7 fill-white text-white ml-1" />
                  </motion.div>
                </button>
                <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
                  <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold backdrop-blur-sm ${preset.chipColor}`}>
                    REAL CAPCUT
                  </span>
                  <span className="rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
                    {tpl.ratio}
                  </span>
                </div>
                <div className="absolute bottom-3 left-3 right-3">
                  <p className="text-sm font-bold text-white line-clamp-2 drop-shadow mb-1">{tpl.title}</p>
                  <div className="flex items-center gap-3 text-[11px] text-white/80">
                    <span className="flex items-center gap-1"><Repeat className="h-3 w-3" />{formatCount(tpl.stats.usage)}</span>
                    <span className="flex items-center gap-1"><Heart className="h-3 w-3" />{formatCount(tpl.stats.like)}</span>
                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{tpl.duration_s}s</span>
                  </div>
                </div>
              </>
            )}
          </motion.div>

          {/* Source badge */}
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/20">
                <Server className="h-4 w-4 text-emerald-400" />
              </div>
              <div className="flex-1">
                <p className="text-xs font-bold text-emerald-300">Live dari server CapCut</p>
                <p className="text-[10px] text-white/40">
                  TemplateID: {tpl.id} · {timeAgo(tpl.upload_date) && `Uploaded ${timeAgo(tpl.upload_date)}`}
                </p>
              </div>
              <a
                href={tpl.share_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-white/70 hover:bg-white/10 hover:text-white"
              >
                <ExternalLink className="h-3 w-3" />
                Buka
              </a>
            </div>
          </div>
        </div>

        {/* Right: Detail card */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className={`relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-zinc-900 via-zinc-950 to-black p-5 shadow-2xl ${preset.glow}`}
        >
          <div className={`pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-gradient-to-br ${preset.gradient} opacity-20 blur-3xl`} />

          <div className="relative flex items-start justify-between">
            <div className="flex items-center gap-2">
              <span className="text-2xl"><Flame className="h-6 w-6 text-orange-400" /></span>
              <div>
                <h2 className="text-base font-bold text-white">JJ Capcut — Detail</h2>
                <p className="text-[11px] text-emerald-400 font-semibold">Real CapCut Data</p>
              </div>
            </div>
            <button
              onClick={() => onCopy(cardText)}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
            >
              <Copy className="h-3 w-3" />
              Copy
            </button>
          </div>

          <div className="relative my-4 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />

          <div className="relative space-y-0.5">
            <FieldRow icon={Hash} label="Judul" value={tpl.title} accent="text-purple-400" />
            <FieldRow icon={Sparkles} label="Short" value={tpl.short || '-'} accent="text-pink-400" />
            <FieldRow icon={Server} label="Source" value="CapCut Server" accent="text-emerald-400" />
            <FieldRow icon={FolderId} label="TemplateID" value={tpl.id} accent="text-amber-400" />
          </div>

          <div className="relative my-4 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />

          <div className="relative space-y-0.5">
            <FieldRow icon={Clock} label="Durasi" value={`${tpl.duration_s}s`} accent="text-orange-400" />
            <FieldRow icon={Layers} label="Fragment" value={String(tpl.fragment || 0)} accent="text-blue-400" />
            <FieldRow icon={Maximize} label="Resolusi" value={tpl.resolution} accent="text-teal-400" />
            <FieldRow icon={Tag} label="Ratio" value={tpl.ratio} accent="text-rose-400" />
          </div>

          <div className="relative my-4 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />

          <div className="relative">
            <div className="mb-2 flex items-center gap-2">
              <TrendingUp className="h-3.5 w-3.5 text-white/60" />
              <span className="text-xs font-semibold uppercase tracking-wider text-white/60">Real Stats</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <StatChip icon={Repeat} label="Usage" value={formatCount(tpl.stats.usage)} color="text-orange-400" />
              <StatChip icon={Play} label="View" value={formatCount(tpl.stats.view)} color="text-red-400" />
              <StatChip icon={Heart} label="Like" value={formatCount(tpl.stats.like)} color="text-pink-400" />
              {tpl.stats.favorite > 0 && (
                <StatChip icon={Star} label="Favorite" value={formatCount(tpl.stats.favorite)} color="text-yellow-400" />
              )}
              {tpl.stats.comment > 0 && (
                <StatChip icon={MessageCircle} label="Comment" value={formatCount(tpl.stats.comment)} color="text-cyan-400" />
              )}
              {tpl.stats.share > 0 && (
                <StatChip icon={Share2} label="Share" value={formatCount(tpl.stats.share)} color="text-emerald-400" />
              )}
            </div>
          </div>

          <div className="relative mt-4 rounded-lg border border-white/5 bg-black/40 p-2.5 text-[10px] text-white/30">
            ✅ Data asli dari <span className="text-emerald-400/70">api.capcut.com</span> via SSR scrape.
            Foto FF screenshot dipakai sebagai placeholder slot upload.
          </div>
        </motion.div>
      </div>

      {/* Your Photos (FF screenshots as upload slots) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-orange-400" />
            <span className="text-sm font-semibold text-white">
              Your Photos <span className="text-white/40">({ffPhotos.length} slot · FF screenshots)</span>
            </span>
          </div>
          <span className={`rounded-md border px-2 py-0.5 text-[10px] font-medium ${preset.chipColor}`}>
            Akan di-insert ke template
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
          {ffPhotos.map((src, idx) => (
            <motion.div
              key={`${src}-${idx}`}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: idx * 0.05, type: 'spring', stiffness: 200 }}
              className="group relative aspect-square overflow-hidden rounded-lg border border-white/10 bg-black/40"
            >
              <img src={src} alt={`FF slot ${idx + 1}`} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-60" />
              <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                <span className={`flex h-5 w-5 items-center justify-center rounded-md text-[10px] font-bold ${preset.chipColor}`}>
                  {idx + 1}
                </span>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RenderView({ tpl, style }: { tpl: CapCutTemplate | null; style: StyleKey }) {
  const preset = STYLES[style]
  const [rendering, setRendering] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoSize, setVideoSize] = useState<number>(0)

  // FF photo URLs (absolute, biar bisa di-download server)
  const ffPhotos = useMemo(
    () => FF_PHOTOS.slice(0, Math.min(tpl?.fragment || 3, 9)).map(p => `${window.location.origin}${p}`),
    [tpl]
  )

  useEffect(() => {
    // Reset state kalau template ganti
    setDone(false)
    setError(null)
    setVideoUrl(null)
    setVideoSize(0)
    setProgress(0)
  }, [tpl?.id])

  if (!tpl) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Film className="h-12 w-12 text-white/20 mb-3" />
        <p className="text-sm text-white/50">Pilih template dulu dari tab Templates</p>
      </div>
    )
  }

  const handleRender = async () => {
    setRendering(true)
    setDone(false)
    setError(null)
    setProgress(10)

    // Simulate progress while waiting for ffmpeg
    const progressInterval = setInterval(() => {
      setProgress(p => Math.min(p + Math.random() * 8, 85))
    }, 400)

    try {
      const resp = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cover_url: tpl.cover_url,
          photos: ffPhotos,
          title: tpl.title,
          ratio: tpl.ratio,
          duration_s: tpl.duration_s || 12,
        }),
      })

      clearInterval(progressInterval)
      setProgress(95)

      if (!resp.ok) {
        // Coba parse error JSON
        let errMsg = `HTTP ${resp.status}`
        try {
          const errBody = await resp.json()
          errMsg = errBody.error || errMsg
          if (errBody.detail) errMsg += `: ${errBody.detail.slice(-300)}`
        } catch {
          errMsg = await resp.text().catch(() => errMsg)
        }
        throw new Error(errMsg)
      }

      // Get MP4 blob
      const blob = await resp.blob()
      if (blob.size < 1000) throw new Error('Output terlalu kecil, ffmpeg mungkin gagal')

      const url = URL.createObjectURL(blob)
      setVideoUrl(url)
      setVideoSize(blob.size)
      setProgress(100)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      clearInterval(progressInterval)
      setRendering(false)
    }
  }

  const handleDownload = () => {
    if (!videoUrl) return
    const a = document.createElement('a')
    a.href = videoUrl
    a.download = `${tpl.title.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60)}.mp4`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className={`relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl ${preset.glow}`}
      >
        {done && videoUrl ? (
          <video
            src={videoUrl}
            controls
            autoPlay
            loop
            className="h-full w-full object-contain bg-black"
          />
        ) : (
          <>
            {tpl.cover_url && (
              <img src={tpl.cover_url} alt={tpl.title} className="h-full w-full object-cover opacity-80" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
            <div className="absolute inset-0 flex items-center justify-center">
              {rendering ? (
                <div className="flex flex-col items-center gap-3 px-4">
                  <Loader2 className="h-12 w-12 animate-spin text-white" />
                  <p className="text-xs text-white/90 font-medium">Rendering dengan ffmpeg...</p>
                  <p className="text-[10px] text-white/60">Composite cover CapCut + {ffPhotos.length} foto FF</p>
                  <div className="mt-2 h-1.5 w-48 overflow-hidden rounded-full bg-white/20">
                    <motion.div
                      animate={{ width: `${progress}%` }}
                      className={`h-full bg-gradient-to-r ${preset.gradient}`}
                    />
                  </div>
                  <p className="text-[10px] text-white/60 tabular-nums">{Math.round(progress)}%</p>
                </div>
              ) : (
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handleRender}
                  className={`flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br ${preset.gradient} shadow-xl`}
                  aria-label="Render video"
                >
                  <Play className="h-7 w-7 fill-white text-white ml-1" />
                </motion.button>
              )}
            </div>
          </>
        )}
        <div className="absolute top-3 left-3 flex items-center gap-2">
          <span className={`rounded-md bg-gradient-to-r ${preset.gradient} px-2 py-0.5 text-[10px] font-bold text-white shadow-lg`}>
            {done ? 'DONE' : rendering ? 'RENDERING' : 'PREVIEW'}
          </span>
          <span className="rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white/80 backdrop-blur-sm">
            {tpl.ratio}
          </span>
        </div>
        <div className="absolute bottom-3 left-3 right-3">
          <p className="text-sm font-bold text-white truncate">{tpl.title}</p>
          <div className="mt-1 flex items-center gap-3 text-[11px] text-white/70">
            <span className="flex items-center gap-1"><Play className="h-3 w-3" />{formatCount(tpl.stats.view)}</span>
            <span className="flex items-center gap-1"><Heart className="h-3 w-3" />{formatCount(tpl.stats.like)}</span>
            <span className="flex items-center gap-1"><Music className="h-3 w-3" />Original</span>
          </div>
        </div>
        {!done && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/40">
            <motion.div
              animate={{ width: `${rendering ? progress : 0}%` }}
              className={`h-full bg-gradient-to-r ${preset.gradient}`}
            />
          </div>
        )}
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-zinc-950 p-5"
      >
        <div className="flex items-center gap-2">
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${preset.gradient}`}>
            <Download className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">
              {done ? 'Done njir! 🗿🔥' : rendering ? 'Rendering...' : 'Ready to render'}
            </h3>
            <p className="text-xs text-white/40">
              {done
                ? `${(videoSize / 1024 / 1024).toFixed(2)} MB · ${tpl.ratio} · MP4 H.264`
                : `${tpl.duration_s}s · ${tpl.ratio} · ${ffPhotos.length} foto FF`
              }
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <div className="flex-1 break-words">
                <p className="font-semibold mb-1">Render gagal:</p>
                <p className="text-[11px] text-red-300/80 break-all">{error}</p>
              </div>
            </div>
          </div>
        )}

        {done ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-white/5 bg-black/40 p-3">
                <p className="text-[10px] uppercase tracking-wider text-white/40">Size</p>
                <p className="text-base font-bold text-white">{(videoSize / 1024 / 1024).toFixed(2)} MB</p>
              </div>
              <div className="rounded-lg border border-white/5 bg-black/40 p-3">
                <p className="text-[10px] uppercase tracking-wider text-white/40">Quality</p>
                <p className="text-base font-bold text-white">1080p</p>
              </div>
              <div className="rounded-lg border border-white/5 bg-black/40 p-3">
                <p className="text-[10px] uppercase tracking-wider text-white/40">Format</p>
                <p className="text-base font-bold text-white">MP4</p>
              </div>
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-300">
              ✅ Video asli di-generate oleh ffmpeg — cover CapCut + {ffPhotos.length} foto FF di-composite jadi MP4 dengan fade transitions
            </div>
            <div className="flex gap-2">
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={handleDownload}
                className={`flex-1 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r ${preset.gradient} px-4 py-2.5 text-sm font-bold text-white shadow-lg`}
              >
                <Download className="h-4 w-4" />
                Download MP4
              </motion.button>
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={handleRender}
                disabled={rendering}
                className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white/80 hover:bg-white/10 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${rendering ? 'animate-spin' : ''}`} />
                Re-render
              </motion.button>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-lg border border-white/5 bg-black/40 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/50">Source Template</span>
                <span className="text-white font-mono text-[10px]">{tpl.id}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/50">Cover CapCut</span>
                <span className="text-white text-[10px] truncate max-w-[60%]">{tpl.cover_url ? '✅ Loaded' : '❌ No cover'}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/50">Foto FF Slots</span>
                <span className="text-white">{ffPhotos.length} foto</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/50">Output</span>
                <span className="text-white">MP4 H.264 · {tpl.ratio}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/50">Engine</span>
                <span className="text-white">ffmpeg server-side</span>
              </div>
            </div>
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={handleRender}
              disabled={rendering}
              className={`flex-1 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r ${preset.gradient} px-4 py-2.5 text-sm font-bold text-white shadow-lg disabled:opacity-50`}
            >
              {rendering ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Rendering... {Math.round(progress)}%
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4" />
                  Render Video (ffmpeg)
                </>
              )}
            </motion.button>
            <p className="text-[10px] text-white/30 text-center">
              Render beneran pakai ffmpeg · composite cover + foto jadi MP4 dengan fade in/out
            </p>
          </>
        )}
      </motion.div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Main Page
// ──────────────────────────────────────────────────────────────
type ViewMode = 'grid' | 'detail' | 'render'

export default function Home() {
  const [style, setStyle] = useState<StyleKey>('viral')
  const [view, setView] = useState<ViewMode>('grid')
  const [templates, setTemplates] = useState<CapCutTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isReal, setIsReal] = useState(false)
  const [categories, setCategories] = useState<string[]>([])
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [selected, setSelected] = useState<CapCutTemplate | null>(null)
  const [copied, setCopied] = useState(false)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchSource, setSearchSource] = useState<string>('')
  const [searchNote, setSearchNote] = useState<string>('')

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSearchQuery('')
    setSearchSource('')
    setSearchNote('')
    try {
      const resp = await fetch('/api/capcut/list?count=60')
      const data: ApiResponse = await resp.json()
      if (data.ok && data.templates && data.templates.length > 0) {
        setTemplates(data.templates)
        setIsReal(data.real)
        setCategories(data.categories || [])
      } else {
        setError(data.error || 'Gagal fetch template')
        setIsReal(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
      setIsReal(false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const handleSearch = useCallback(async (q: string) => {
    const query = q.trim()
    if (!query) {
      fetchTemplates()
      return
    }

    setSearching(true)
    setError(null)
    setSearchQuery(query)
    setSearchSource('')
    setSearchNote('')

    try {
      const resp = await fetch(`/api/capcut/search?q=${encodeURIComponent(query)}&count=30`)
      const data: ApiResponse = await resp.json()

      if (data.ok && data.templates && data.templates.length > 0) {
        setTemplates(data.templates)
        setIsReal(data.real)
        setSearchSource(data.source || '')
        setSearchNote(data.note || '')
        setCategories([])
        setActiveCategory('all')
      } else {
        setTemplates([])
        setError(data.error || `Tidak nemu template untuk "${query}"`)
        setSearchSource(data.source || '')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
      setTemplates([])
    } finally {
      setSearching(false)
    }
  }, [fetchTemplates])

  const handlePick = useCallback((tpl: CapCutTemplate) => {
    setSelected(tpl)
    setView('detail')
  }, [])

  const handleCopy = (text: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {})
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const filtered = useMemo(() => {
    if (activeCategory === 'all') return templates
    return templates.slice(0, 60) // category filter tidak exact karena kita ambil semua jadi satu
  }, [templates, activeCategory])

  const stylePreset = STYLES[style]

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-white relative overflow-x-hidden">
      {/* Ambient bg */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className={`absolute -top-40 -left-40 h-96 w-96 rounded-full bg-gradient-to-br ${stylePreset.gradient} opacity-10 blur-3xl transition-all duration-700`} />
        <div className={`absolute top-1/2 -right-40 h-96 w-96 rounded-full bg-gradient-to-br ${stylePreset.gradient} opacity-10 blur-3xl transition-all duration-700`} />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.03),transparent_70%)]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={`flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${stylePreset.gradient} shadow-lg ${stylePreset.glow} transition-all`}>
              <Flame className="h-5 w-5 text-white" />
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-bold text-white">JJ CapCut Generator</h1>
              <p className="text-[10px] text-white/40">Free Fire Edition · Live CapCut</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`hidden sm:flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium ${
              isReal
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
            }`}>
              {isReal ? <Wifi className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
              {isReal ? 'LIVE CapCut' : 'Fallback'}
            </span>
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={fetchTemplates}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/10 hover:text-white transition disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </motion.button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative mx-auto max-w-6xl w-full px-4 pt-6 pb-4">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`flex items-center gap-1.5 rounded-full border ${stylePreset.chipColor} px-3 py-1 text-[11px] font-medium`}>
              <Flame className="h-3 w-3" />
              Free Fire Themed
            </span>
            {isReal && (
              <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-300">
                <Server className="h-3 w-3" />
                Real CapCut Data
              </span>
            )}
            {templates.length > 0 && (
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-white/60">
                {templates.length} templates
              </span>
            )}
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Template CapCut asli dari{' '}
            <span className={`bg-gradient-to-r ${stylePreset.gradient} bg-clip-text text-transparent transition-all`}>
              server CapCut
            </span>
          </h2>
          <p className="text-sm text-white/50 max-w-2xl">
            Langsung nembak ke <code className="rounded bg-white/5 px-1 text-emerald-300">api.capcut.com</code> via SSR scrape.
            Template asli + cover + video URL + real stats. Foto FF kamu dipakai sebagai slot upload placeholder.
          </p>
        </motion.div>
      </section>

      {/* Style selector */}
      <section className="mx-auto max-w-6xl w-full px-4 py-4">
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {styleKeys.map(k => (
            <motion.button
              key={k}
              whileTap={{ scale: 0.96 }}
              onClick={() => setStyle(k)}
              className={`
                relative flex flex-col items-start gap-0.5 rounded-xl border p-2.5 text-left transition-all
                ${k === style
                  ? `border-white/20 bg-gradient-to-br ${STYLES[k].gradient} shadow-lg ${STYLES[k].glow}`
                  : 'border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]'
                }
              `}
            >
              <span className={`text-xs font-bold ${k === style ? 'text-white' : 'text-white/70'}`}>
                {STYLES[k].label}
              </span>
            </motion.button>
          ))}
        </div>
      </section>

      {/* View tabs */}
      <section className="mx-auto max-w-6xl w-full px-4 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-white/10 bg-black/40 p-1">
            {([
              { k: 'grid' as const, label: 'Templates', icon: Grid3x3 },
              { k: 'render' as const, label: 'Render', icon: Film },
            ]).map(t => (
              <button
                key={t.k}
                onClick={() => setView(t.k)}
                className={`
                  relative flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium transition
                  ${view === t.k ? 'text-white' : 'text-white/50 hover:text-white/80'}
                `}
              >
                {view === t.k && (
                  <motion.div
                    layoutId="viewTab"
                    className={`absolute inset-0 rounded-lg bg-gradient-to-r ${stylePreset.gradient} shadow-lg`}
                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                  />
                )}
                <span className="relative z-10 flex items-center gap-1.5">
                  <t.icon className="h-3.5 w-3.5" />
                  {t.label}
                </span>
              </button>
            ))}
          </div>
          {view === 'detail' && selected && (
            <button
              onClick={() => setView('grid')}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:bg-white/10"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
          )}

          {/* Search bar */}
          {view === 'grid' && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                handleSearch(searchInput)
              }}
              className="flex flex-1 min-w-[200px] items-center gap-1.5"
            >
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Cari template CapCut: phonk, viral, edit, collage..."
                  className="w-full rounded-lg border border-white/10 bg-black/40 py-1.5 pl-8 pr-3 text-xs text-white placeholder:text-white/30 focus:border-white/20 focus:outline-none focus:ring-1 focus:ring-white/10"
                />
              </div>
              <button
                type="submit"
                disabled={searching}
                className={`flex items-center gap-1 rounded-lg bg-gradient-to-r ${stylePreset.gradient} px-3 py-1.5 text-xs font-bold text-white shadow-lg disabled:opacity-50`}
              >
                {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                Cari
              </button>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('')
                    fetchTemplates()
                  }}
                  className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-white/60 hover:bg-white/10 hover:text-white"
                  title="Reset ke trending"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </form>
          )}
        </div>

        {/* Search info bar */}
        {view === 'grid' && searchQuery && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-white/40">Hasil cari untuk:</span>
            <span className={`rounded-md border px-2 py-0.5 font-medium ${stylePreset.chipColor}`}>
              "{searchQuery}"
            </span>
            <span className="text-white/40">·</span>
            <span className="text-white/60">{templates.length} template</span>
            {searchSource && (
              <>
                <span className="text-white/40">·</span>
                <span className="text-white/40">source: <code className="text-emerald-300/80">{searchSource}</code></span>
              </>
            )}
          </div>
        )}
        {view === 'grid' && searchNote && (
          <div className="mt-1.5 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-300/80">
            ⚠️ {searchNote}
          </div>
        )}
      </section>

      {/* Main content */}
      <main className="mx-auto max-w-6xl w-full px-4 py-6 flex-1">
        <AnimatePresence mode="wait">
          {view === 'grid' && (
            <motion.div
              key="grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {loading ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <Loader2 className={`h-10 w-10 animate-spin bg-gradient-to-br ${stylePreset.gradient} bg-clip-text text-transparent`} />
                  <p className="mt-3 text-sm text-white/60">Nembak ke server CapCut...</p>
                  <p className="mt-1 text-[11px] text-white/30">Fetch /template → parse SSR → extract templates</p>
                </div>
              ) : error ? (
                <div className="flex flex-col items-center justify-center py-20 text-center">
                  <AlertCircle className="h-10 w-10 text-amber-400 mb-3" />
                  <p className="text-sm font-semibold text-white">Gagal ambil data CapCut</p>
                  <p className="text-xs text-white/50 mt-1 max-w-md">{error}</p>
                  <button
                    onClick={fetchTemplates}
                    className="mt-4 flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Coba lagi
                  </button>
                </div>
              ) : (
                <>
                  {/* Categories filter */}
                  {categories.length > 0 && (
                    <div className="mb-4 flex flex-wrap gap-1.5">
                      <button
                        onClick={() => setActiveCategory('all')}
                        className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                          activeCategory === 'all'
                            ? `border-white/20 bg-gradient-to-r ${stylePreset.gradient} text-white`
                            : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10'
                        }`}
                      >
                        All ({templates.length})
                      </button>
                      {categories.slice(0, 8).map(cat => (
                        <span
                          key={cat}
                          className="rounded-full border border-white/5 bg-white/[0.02] px-3 py-1 text-[11px] text-white/40"
                        >
                          {cat}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                    {filtered.map((tpl, idx) => (
                      <TemplateCard
                        key={tpl.id}
                        tpl={tpl}
                        style={style}
                        onPick={handlePick}
                        index={idx}
                      />
                    ))}
                  </div>
                </>
              )}
            </motion.div>
          )}

          {view === 'detail' && selected && (
            <motion.div
              key={`detail-${selected.id}`}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <DetailView
                tpl={selected}
                style={style}
                onBack={() => setView('grid')}
                onCopy={handleCopy}
              />
            </motion.div>
          )}

          {view === 'render' && (
            <motion.div
              key="render"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <RenderView tpl={selected} style={style} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Copy toast */}
        <AnimatePresence>
          {copied && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="fixed bottom-6 right-6 z-50"
            >
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 shadow-xl backdrop-blur-md">
                <Check className="h-4 w-4 text-emerald-400" />
                <span className="text-xs font-medium text-emerald-300">Card text disalin!</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-white/5 bg-zinc-950">
        <div className="mx-auto max-w-6xl px-4 py-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-white/40">
            <Flame className={`h-4 w-4 bg-gradient-to-br ${stylePreset.gradient} bg-clip-text text-transparent`} />
            <span>JJ CapCut Generator · Free Fire Edition</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-white/40">
            <span className="flex items-center gap-1">
              <Server className="h-3 w-3" /> {isReal ? 'CapCut SSR' : 'Fallback'}
            </span>
            <span className="flex items-center gap-1">
              <Headphones className="h-3 w-3" /> Phonk
            </span>
            <span className="flex items-center gap-1">
              <Clapperboard className="h-3 w-3" /> {templates.length} templates
            </span>
            <span>·</span>
            <span>buat test aja ✨</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
