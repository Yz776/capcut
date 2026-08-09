// /api/capcut/detail — Ambil detail 1 template CapCut by ID
// Nembak https://www.capcut.com/api/template/detail?p=<id>

import { NextRequest, NextResponse } from 'next/server'

const CC_BASE = 'https://www.capcut.com'

function buildHeaders() {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    Referer: 'https://www.capcut.com/templates',
    Origin: 'https://www.capcut.com',
    'Sec-Ch-Ua': '"Chromium";v="130", "Not_A Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  }
}

const ENDPOINTS = [
  '/api/template/detail',
  '/api/template/pc/detail',
  '/api/template/info',
]

interface RawDetail {
  template_id?: string
  id?: string
  title?: string
  desc?: string
  duration?: number
  video?: { url?: string; cover_url?: string; duration?: number; width?: number; height?: number }
  cover_url?: string
  video_url?: string
  author?: { uid?: string; username?: string; nickname?: string; avatar_url?: string }
  user?: { uid?: string; username?: string; nickname?: string; avatar_url?: string }
  template_segment_count?: number
  video_duration?: number
  like_count?: number
  use_count?: number
  view_count?: number
  collect_count?: number
  share_count?: number
  comment_count?: number
  play_count?: number
  usage_count?: number
  [key: string]: unknown
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

function extract(raw: RawDetail) {
  const id = String(raw.template_id || raw.id || '')
  const author = raw.author || raw.user || {}
  const video = raw.video || {}
  const cover = video.cover_url || raw.cover_url || ''
  const videoUrl = video.url || raw.video_url || ''
  const width = video.width || 1080
  const height = video.height || 1920
  const g = gcd(width, height)

  return {
    id,
    title: raw.title || raw.desc || 'Untitled',
    desc: raw.desc || '',
    short: raw.desc || raw.title || '',
    author: author.nickname || author.username || 'Unknown',
    username: author.username ? `@${author.username}` : '',
    author_avatar: author.avatar_url || '',
    cover_url: cover,
    video_url: videoUrl,
    duration_s: video.duration ? Math.round(video.duration / 1000) : 0,
    fragment: raw.template_segment_count || 0,
    width,
    height,
    ratio: `${width / g}:${height / g}`,
    resolution: `${width}x${height}`,
    stats: {
      like: raw.like_count ?? 0,
      usage: raw.use_count ?? raw.usage_count ?? 0,
      view: raw.view_count ?? raw.play_count ?? 0,
      favorite: raw.collect_count ?? 0,
      comment: raw.comment_count ?? 0,
      share: raw.share_count ?? 0,
    },
    share_url: id ? `https://www.capcut.com/t/${id}/` : '',
    raw,
  }
}

export async function GET(req: NextRequest) {
  const search = req.nextUrl.searchParams
  const id = search.get('id') || search.get('p') || ''

  if (!id) {
    return NextResponse.json(
      { ok: false, real: false, error: 'Parameter id wajib diisi' },
      { status: 400 }
    )
  }

  const tried: Array<{ url: string; status: number; ok: boolean; error?: string }> = []

  for (const ep of ENDPOINTS) {
    const url = new URL(CC_BASE + ep)
    url.searchParams.set('p', id)
    url.searchParams.set('end_user_id', '')
    url.searchParams.set('enter_from', '')

    try {
      const resp = await fetch(url.toString(), {
        method: 'GET',
        headers: buildHeaders(),
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })

      tried.push({ url: ep, status: resp.status, ok: resp.ok })
      if (!resp.ok) continue

      const text = await resp.text()
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        tried[tried.length - 1].error = 'Invalid JSON'
        continue
      }

      const wrapper = data as { code?: number; message?: string; data?: unknown }
      if (wrapper.code !== undefined && wrapper.code !== 0) {
        tried[tried.length - 1].error = `code=${wrapper.code} msg=${wrapper.message || ''}`
        continue
      }

      const payload = wrapper.data ?? data
      if (!payload || typeof payload !== 'object') {
        tried[tried.length - 1].error = 'No data object'
        continue
      }

      const detail = extract(payload as RawDetail)
      if (!detail.id) {
        tried[tried.length - 1].error = 'No template_id in payload'
        continue
      }

      return NextResponse.json({
        ok: true,
        real: true,
        source: 'capcut',
        endpoint: ep,
        detail,
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
    error: 'Detail CapCut tidak bisa diambil (anti-bot / region block).',
    tried,
  })
}
