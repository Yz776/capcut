// /api/render — Real video render pakai ffmpeg server-side.
// POST { cover_url, photos: string[], title, ratio, duration_s }
// Output: MP4 file (slideshow dengan fade transitions), download langsung.

import { NextRequest, NextResponse } from 'next/server'
import { writeFile, readFile, mkdir, rm, access } from 'fs/promises'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import crypto from 'crypto'

const execAsync = promisify(exec)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

async function downloadFile(url: string, dest: string): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'image/*,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
      cache: 'no-store',
    })
    if (!resp.ok) return false
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length < 100) return false
    await writeFile(dest, buf)
    return true
  } catch {
    return false
  }
}

interface RenderBody {
  cover_url?: string
  photos?: string[]
  title?: string
  ratio?: string
  duration_s?: number
}

export async function POST(req: NextRequest) {
  let body: RenderBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Body harus JSON' }, { status: 400 })
  }

  const {
    cover_url,
    photos = [],
    title = 'capcut-render',
    ratio = '9:16',
    duration_s = 15,
  } = body

  if (!cover_url && photos.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'cover_url atau photos wajib diisi' },
      { status: 400 }
    )
  }

  const jobId = crypto.randomBytes(6).toString('hex')
  const workDir = `/tmp/render-${jobId}`
  await mkdir(workDir, { recursive: true })
  const outputPath = path.join(workDir, 'output.mp4')

  try {
    // Download semua gambar (cover CapCut + foto FF)
    const allImages: string[] = []

    if (cover_url) {
      const coverPath = path.join(workDir, 'cover.jpg')
      if (await downloadFile(cover_url, coverPath)) {
        allImages.push(coverPath)
      }
    }

    for (let i = 0; i < photos.length; i++) {
      const p = path.join(workDir, `photo-${String(i).padStart(2, '0')}.jpg`)
      if (await downloadFile(photos[i], p)) {
        allImages.push(p)
      }
    }

    if (allImages.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'Gagal download semua gambar' },
        { status: 502 }
      )
    }

    // Parse ratio
    const [rw, rh] = ratio.split(':').map(n => parseInt(n, 10) || 0)
    let targetW = 1080
    let targetH = 1920
    if (rw && rh) {
      if (rw > rh) { targetW = 1920; targetH = 1080 }      // landscape
      else if (rw === rh) { targetW = 1080; targetH = 1080 } // square
      // portrait default 1080x1920
    }

    // Per-image duration
    const perImg = Math.max(1, Math.floor(duration_s / allImages.length))
    const totalDur = perImg * allImages.length

    // Build concat list file
    // Format: file 'photo.jpg'\nduration <sec>\n... repeat last line
    const listLines: string[] = []
    for (const img of allImages) {
      listLines.push(`file '${img.replace(/'/g, "'\\''")}'`)
      listLines.push(`duration ${perImg}`)
    }
    // Concat demuxer requires last file to be repeated without duration
    listLines.push(`file '${allImages[allImages.length - 1].replace(/'/g, "'\\''")}'`)
    const listPath = path.join(workDir, 'list.txt')
    await writeFile(listPath, listLines.join('\n'))

    // Build ffmpeg command — concat demuxer + scale/crop + fade in/out
    const fadeOutStart = Math.max(0, totalDur - 0.5)
    const filter = [
      `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase`,
      `crop=${targetW}:${targetH}`,
      'setsar=1',
      'fade=t=in:st=0:d=0.5',
      `fade=t=out:st=${fadeOutStart}:d=0.5`,
      'format=yuv420p',
    ].join(',')

    const cmd = [
      'ffmpeg -y',
      `-f concat -safe 0 -i "${listPath}"`,
      `-vf "${filter}"`,
      '-r 30',
      '-c:v libx264',
      '-preset fast',
      '-crf 23',
      '-movflags +faststart',
      `"${outputPath}"`,
    ].join(' ')

    try {
      await execAsync(cmd, { timeout: 90000 })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      return NextResponse.json(
        {
          ok: false,
          error: 'ffmpeg gagal render',
          detail: errMsg.slice(-1500),
          cmd,
        },
        { status: 500 }
      )
    }

    // Verify output
    try {
      await access(outputPath)
    } catch {
      return NextResponse.json(
        { ok: false, error: 'ffmpeg selesai tapi output tidak ditemukan' },
        { status: 500 }
      )
    }

    const videoBuffer = await readFile(outputPath)
    if (videoBuffer.length < 1000) {
      return NextResponse.json(
        { ok: false, error: 'Output terlalu kecil, mungkin ffmpeg gagal' },
        { status: 500 }
      )
    }

    // Cleanup in background
    setTimeout(() => {
      rm(workDir, { recursive: true, force: true }).catch(() => {})
    }, 2000)

    // Safe filename
    const safeName = title.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60) || 'capcut-render'

    return new NextResponse(videoBuffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${safeName}.mp4"`,
        'Content-Length': String(videoBuffer.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (e) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}

// GET = status check
export async function GET() {
  try {
    const { stdout } = await execAsync('ffmpeg -version', { timeout: 5000 })
    const version = stdout.split('\n')[0]
    return NextResponse.json({
      ok: true,
      service: 'render',
      ffmpeg: version,
      codec: 'libx264 available',
    })
  } catch {
    return NextResponse.json(
      { ok: false, error: 'ffmpeg tidak tersedia' },
      { status: 500 }
    )
  }
}
