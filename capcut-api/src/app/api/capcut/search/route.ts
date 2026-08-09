// /api/capcut/search — Cari template CapCut by keyword.
// Strategi:
// 1. Coba DuckDuckGo: site:capcut.com/template-detail <keyword> → fetch detail page
// 2. Kalau DDG kosong, filter dari list template trending yang sudah di-fetch dari /template page
// 3. Return dengan flag source yang jelas

import { NextRequest, NextResponse } from 'next/server'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

interface RawTpl {
  templateId?: string
  coverUrl?: string
  videoUrl?: string
  title?: string
  titleDesc?: string
  templateDuration?: number
  coverWidth?: number
  coverHeight?: number
  useCount?: number
  likeCount?: number
  collectCount?: number
  shareCount?: number
  commentCount?: number
  playCount?: number
  viewCount?: number
  templateURL?: string
  duration?: number
  structuredData?: {
    name?: string
    description?: string
    duration?: number
    clipsCount?: number
    thumbnailUrl?: string
    contentUrl?: string
    aspectRatio?: string
    uploadDate?: number
    interactionStatistic?: { likeCount?: number; useCount?: number }
    url?: string
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function extract(raw: RawTpl) {
  const id = String(raw.templateId || '')
  const sd = raw.structuredData || {}
  const cover = raw.coverUrl || sd.thumbnailUrl || ''
  const videoUrl = raw.videoUrl || sd.contentUrl || ''
  const width = raw.coverWidth || 1080
  const height = raw.coverHeight || 1920
  const g = gcd(width, height)
  const ratio = sd.aspectRatio || `${width / g}:${height / g}`
  const durationMs = raw.templateDuration || raw.duration || sd.duration || 0

  return {
    id,
    title: (raw.title || sd.name || '').trim() || 'Untitled',
    desc: raw.titleDesc || sd.description || '',
    short: raw.titleDesc || sd.description || '',
    author: 'CapCut Creator',
    username: '',
    cover_url: cover,
    video_url: videoUrl,
    duration_s: Math.round(durationMs / 1000),
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
    share_url: raw.templateURL || sd.url || (id ? `https://www.capcut.com/t/${id}/` : ''),
    template_url: raw.templateURL || sd.url || '',
    upload_date: sd.uploadDate || 0,
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/\\u002F/g, '/')
}

// Scrape Bing search results (DDG timed out dari sandbox)
async function searchBing(keyword: string, limit = 15): Promise<string[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(`site:capcut.com/template-detail ${keyword}`)}&count=30`
  const ids = new Set<string>()

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    })

    if (!resp.ok) return []
    const html = await resp.text()

    // Bing URLs ada di <cite> elements dan di href attribute
    const idPattern = /capcut\.com\/(?:[a-z-]+\/)?template-detail\/[^"'\s<>]*?\/(\d{15,25})/g
    let m: RegExpExecArray | null
    while ((m = idPattern.exec(html)) !== null) {
      ids.add(m[1])
      if (ids.size >= limit) break
    }
  } catch {
    // network error
  }

  return Array.from(ids)
}

async function fetchTemplateDetail(templateId: string): Promise<RawTpl | null> {
  const urls = [
    `https://www.capcut.com/zh-tw/template-detail/t/${templateId}`,
    `https://www.capcut.com/en/template-detail/t/${templateId}`,
    `https://www.capcut.com/template-detail/t/${templateId}`,
    `https://www.capcut.com/t/${templateId}/`,
  ]

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
      })

      if (!resp.ok) continue
      const html = await resp.text()

      // Cari object dengan templateId ini di __MODERN_SSR_DATA__ atau inline JSON
      const objPattern = new RegExp(
        `\\{[^{}]*"templateId":"${templateId}"[^{}]*"coverUrl":"[^"]+"[^{}]*\\}`,
        's'
      )
      const objMatch = html.match(objPattern)
      if (!objMatch) continue

      const decoded = decodeEntities(objMatch[0])
      try {
        return JSON.parse(decoded)
      } catch {
        // Extract field-by-field
        const fields: RawTpl = { templateId }
        const fieldPatterns: Array<[keyof RawTpl, RegExp]> = [
          ['coverUrl', /"coverUrl":"([^"]+)"/],
          ['videoUrl', /"videoUrl":"([^"]+)"/],
          ['title', /"title":"([^"]+)"/],
          ['titleDesc', /"titleDesc":"([^"]+)"/],
          ['templateDuration', /"templateDuration":(\d+)/],
          ['coverWidth', /"coverWidth":(\d+)/],
          ['coverHeight', /"coverHeight":(\d+)/],
          ['useCount', /"useCount":(\d+)/],
          ['likeCount', /"likeCount":(\d+)/],
          ['templateURL', /"templateURL":"([^"]+)"/],
        ]
        for (const [key, pat] of fieldPatterns) {
          const fm = decoded.match(pat)
          if (fm) {
            ;(fields[key] as unknown) = key.includes('Count') || key === 'templateDuration' || key === 'coverWidth' || key === 'coverHeight'
              ? parseInt(fm[1], 10)
              : fm[1]
          }
        }
        if (fields.coverUrl || fields.title) return fields
      }
    } catch {
      // continue
    }
  }

  return null
}

// Fallback: scrape /template page (sama kayak /api/capcut/list) lalu filter by keyword
async function fallbackFilterFromList(keyword: string, limit: number) {
  try {
    const resp = await fetch('https://www.capcut.com/template', {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    })

    if (!resp.ok) return []
    const html = await resp.text()

    const templates: RawTpl[] = []
    const regex = /data-fn-args='([^']+)'/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(html)) !== null) {
      const raw = match[1]
      if (!raw.includes('template_page') || !raw.includes('videoTemplateLists')) continue

      const decoded = decodeEntities(raw)
      try {
        const parsed = JSON.parse(decoded)
        if (!Array.isArray(parsed) || parsed.length < 3) continue
        const cats = parsed[2]
        if (!cats || typeof cats !== 'object') continue

        for (const catVal of Object.values(cats as Record<string, unknown>)) {
          const cat = catVal as { data?: { videoTemplates?: RawTpl[] } }
          if (!cat.data?.videoTemplates) continue
          for (const t of cat.data.videoTemplates) {
            if (t && t.templateId) templates.push(t)
          }
        }
      } catch {
        // skip
      }
    }

    // Dedupe
    const seen = new Set<string>()
    const deduped = templates.filter(t => {
      const id = String(t.templateId || '')
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })

    // Filter by keyword in title or titleDesc
    const kw = keyword.toLowerCase()
    const matched = deduped.filter(t => {
      const title = (t.title || '').toLowerCase()
      const desc = (t.titleDesc || '').toLowerCase()
      return title.includes(kw) || desc.includes(kw)
    })

    return matched.slice(0, limit)
  } catch {
    return []
  }
}

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams
  const keyword = (search.get('q') || search.get('keyword') || '').trim()
  const limit = Math.min(parseInt(search.get('count') || '15', 10), 30)

  if (!keyword) {
    return NextResponse.json(
      { ok: false, error: 'Parameter q (keyword) wajib diisi' },
      { status: 400 }
    )
  }

  // Step 1: Coba cari IDs via Bing
  const ids = await searchBing(keyword, limit)

  if (ids.length > 0) {
    // Step 2: Fetch detail tiap ID
    const templates = []
    const batchSize = 5
    for (let i = 0; i < ids.length && templates.length < limit; i += batchSize) {
      const batch = ids.slice(i, i + batchSize)
      const results = await Promise.allSettled(batch.map(id => fetchTemplateDetail(id)))
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          templates.push(extract(r.value))
        }
      }
    }

    if (templates.length > 0) {
      return NextResponse.json({
        ok: true,
        real: true,
        source: 'capcut-via-bing',
        keyword,
        found_ids: ids.length,
        count: templates.length,
        templates: templates.slice(0, limit),
      })
    }
  }

  // Fallback: filter dari list trending
  const matched = await fallbackFilterFromList(keyword, limit)

  if (matched.length > 0) {
    return NextResponse.json({
      ok: true,
      real: true,
      source: 'filter-from-trending',
      keyword,
      note: 'CapCut search client-side only (butuh signature). Hasil ini di-filter dari 60 template trending CapCut.',
      count: matched.length,
      templates: matched.map(extract),
    })
  }

  return NextResponse.json({
    ok: false,
    real: false,
    source: 'no-match',
    keyword,
    error: `Tidak nemu template CapCut untuk keyword "${keyword}". Coba keyword lain seperti: phonk, viral, edit, collage, aesthetic.`,
    tried_bing: ids.length,
  })
}
