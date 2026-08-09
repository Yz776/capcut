// /api/capcut/list — Proxy ke server CapCut asli via SSR page scrape.
// CapCut embeds template data di HTML halaman /template (script data-fn-name="r").
// Kita fetch HTML, parse script tag, decode HTML entities, ambil videoTemplates.
// Ini jauh lebih reliable daripada hit /api/* (yang butuh signature).

import { NextRequest, NextResponse } from 'next/server'

const CC_BASE = 'https://www.capcut.com'

function buildHeaders() {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'Sec-Ch-Ua': '"Chromium";v="130", "Not_A Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  }
}

interface RawTpl {
  useCount?: number
  likeCount?: number
  templateDuration?: number
  coverHeight?: number
  coverWidth?: number
  templateId?: string
  coverUrl?: string
  titleDesc?: string
  templateURL?: string
  title?: string
  videoUrl?: string
  structuredData?: {
    uploadDate?: number
    duration?: number
    clipsCount?: number
    name?: string
    description?: string
    thumbnailUrl?: string
    contentUrl?: string
    interactionStatistic?: { likeCount?: number; useCount?: number }
    url?: string
    aspectRatio?: string
  }
  duration?: number
  collectCount?: number
  shareCount?: number
  commentCount?: number
  playCount?: number
  viewCount?: number
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function extractTemplate(raw: RawTpl) {
  const id = String(raw.templateId || '')
  const sd = raw.structuredData || {}
  const cover = raw.coverUrl || sd.thumbnailUrl || ''
  const videoUrl = raw.videoUrl || sd.contentUrl || ''
  const width = raw.coverWidth || 1080
  const height = raw.coverHeight || 1920
  const g = gcd(width, height)
  const ratio = sd.aspectRatio || `${width / g}:${height / g}`
  const durationMs = raw.templateDuration || raw.duration || sd.duration || 0
  const durationS = Math.round(durationMs / 1000)

  return {
    id,
    title: (raw.title || sd.name || '').trim() || 'Untitled',
    desc: raw.titleDesc || sd.description || '',
    short: raw.titleDesc || sd.description || '',
    author: 'CapCut Creator',
    username: '',
    author_avatar: '',
    cover_url: cover,
    video_url: videoUrl,
    duration_s: durationS,
    fragment: sd.clipsCount || 0,
    width,
    height,
    ratio,
    resolution: `${width}x${height}`,
    stats: {
      like: raw.likeCount ?? sd.interactionStatistic?.likeCount ?? 0,
      usage: raw.useCount ?? sd.interactionStatistic?.useCount ?? 0,
      view: raw.playCount ?? raw.viewCount ?? raw.useCount ?? 0,
      favorite: raw.collectCount ?? 0,
      comment: raw.commentCount ?? 0,
      share: raw.shareCount ?? 0,
    },
    share_url: raw.templateURL || (id ? `https://www.capcut.com/t/${id}/` : ''),
    template_url: raw.templateURL || '',
    upload_date: sd.uploadDate || 0,
  }
}

// Decode HTML entities yang umum di script data-fn-args CapCut
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
}

// Cari & parse semua script data-fn-name="r" dengan args template_page
function parseSsrTemplates(html: string): { templates: RawTpl[]; categories: string[] } {
  const templates: RawTpl[] = []
  const categories: string[] = []

  // Match semua script dengan data-fn-name="r" yang args-nya mulai dengan "template_page"
  // Format: data-fn-args='["\"template_page\"","\"videoTemplateLists\"",{"category-key":{"data":{"videoTemplates":[...]}}}]}'
  // Atau: data-fn-args='["\"template_page\"","\"videoTemplateLists\"",{"editors-pick":{"data":{...}}}]'
  const regex = /data-fn-args='([^']+)'/g
  let match: RegExpExecArray | null

  while ((match = regex.exec(html)) !== null) {
    const raw = match[1]
    if (!raw.includes('template_page')) continue
    if (!raw.includes('videoTemplateLists')) continue

    const decoded = decodeEntities(raw)
    try {
      const parsed = JSON.parse(decoded)
      // parsed = ["template_page", "videoTemplateLists", { categoryKey: { data: { videoTemplates, hasMore, nextCursor } } }]
      if (!Array.isArray(parsed) || parsed.length < 3) continue
      const categoriesObj = parsed[2]
      if (!categoriesObj || typeof categoriesObj !== 'object') continue

      for (const [catKey, catVal] of Object.entries(categoriesObj as Record<string, unknown>)) {
        const cat = catVal as { data?: { videoTemplates?: RawTpl[]; hasMore?: boolean; nextCursor?: string } }
        if (!cat.data?.videoTemplates) continue
        categories.push(catKey)
        for (const t of cat.data.videoTemplates) {
          if (t && t.templateId) templates.push(t)
        }
      }
    } catch {
      // skip malformed
    }
  }

  return { templates, categories }
}

// Dedupe templates by ID
function dedupe(templates: RawTpl[]): RawTpl[] {
  const seen = new Set<string>()
  const out: RawTpl[] = []
  for (const t of templates) {
    const id = String(t.templateId || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(t)
  }
  return out
}

// Halaman CapCut yang bisa di-scrape (semua punya SSR template data)
const PAGES = [
  { path: '/en/template', label: 'en-template' },
  { path: '/template', label: 'root-template' },
  { path: '/zh-tw/template', label: 'zh-tw-template' },
  { path: '/id/template', label: 'id-template' },
]

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams
  const limit = Math.min(parseInt(search.get('count') || '30', 10), 60)

  const tried: Array<{ url: string; status: number; ok: boolean; error?: string; found?: number }> = []

  for (const page of PAGES) {
    const url = CC_BASE + page.path

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(),
        cache: 'no-store',
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      })

      const found = { url: page.path, status: resp.status, ok: resp.ok, found: 0 }
      tried.push(found)

      if (!resp.ok) {
        found.error = `HTTP ${resp.status}`
        continue
      }

      const html = await resp.text()
      if (html.length < 5000) {
        found.error = 'HTML too short (likely blocked)'
        continue
      }

      const { templates: raw, categories } = parseSsrTemplates(html)
      found.found = raw.length

      if (raw.length === 0) {
        found.error = 'No templates parsed from SSR'
        continue
      }

      const deduped = dedupe(raw).slice(0, limit)
      const extracted = deduped.map(extractTemplate).filter(t => t.id && t.cover_url)

      if (extracted.length === 0) {
        found.error = 'No valid templates with cover'
        continue
      }

      return NextResponse.json({
        ok: true,
        real: true,
        source: 'capcut-ssr',
        page: page.path,
        categories,
        count: extracted.length,
        templates: extracted,
        tried,
      })
    } catch (e) {
      tried[tried.length - 1].error = e instanceof Error ? e.message : String(e)
      continue
    }
  }

  return NextResponse.json({
    ok: false,
    real: false,
    source: 'fallback',
    error: 'CapCut SSR scrape gagal semua (kemungkinan IP diblokir atau struktur halaman berubah).',
    tried,
  })
}
