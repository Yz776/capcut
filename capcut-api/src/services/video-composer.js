// src/services/video-composer.js
// FFmpeg-based video composer untuk template CapCut.
//
// Karena CapCut editor web membutuhkan session login yang FULLY authenticated
// (sessionid + sid_guard + uid_tt — yang tidak didapat dari QR login basic),
// kita pakai pendekatan alternatif:
//
// 1. Download template preview MP4 (dari /templates/:id → videoUrl).
// 2. Overlay gambar user ke video dengan ffmpeg, dengan strategi:
//    a. Default: gambar di-place di tengah dengan opacity 1.0, full screen (cover).
//    b. Kalau template aspect rasio 9:16 (portrait, default CapCut), gambar di-scale ke full.
//    c. Kalau ada info slot position dari user (x, y, w, h dalam %), pakai itu.
// 3. Output video MP4 H.264 yang siap download.
//
// File ini TIDAK butuh browser/Puppeteer/CapCut login — pure ffmpeg + axios.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import axios from 'axios';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

/**
 * Compose video dengan overlay images ke template preview video.
 *
 * @param {Object} opts
 * @param {Object} opts.template - { id, title, videoUrl, coverUrl, durationSec }
 * @param {string[]} opts.imagePaths - local file paths to overlay
 * @param {string} opts.outputPath - where to save final MP4
 * @param {Object} opts.layout - optional: { mode: 'cover'|'contain'|'grid', positions: [{x,y,w,h}] }
 * @param {Function} opts.onProgress - (pct, msg) => void
 * @returns {Object} { outputPath, durationSec, sizeBytes }
 */
export async function composeTemplateVideo({ template, imagePaths, outputPath, layout, onProgress }) {
  if (!imagePaths?.length) throw new Error('imagePaths required');
  if (!template?.videoUrl) {
    throw new Error('Template must have videoUrl (preview MP4). Run getTemplateInfo first.');
  }
  if (!outputPath) throw new Error('outputPath required');

  const progress = (pct, msg) => {
    logger.info({ pct, msg }, 'compose progress');
    onProgress?.(pct, msg);
  };

  const workDir = path.dirname(outputPath);
  await fs.mkdir(workDir, { recursive: true });

  // Step 1: Download template preview video
  progress(5, 'Downloading template preview video');
  const tplVideoPath = path.join(workDir, `_tpl_${template.id}.mp4`);
  if (!existsSync(tplVideoPath)) {
    await downloadFile(template.videoUrl, tplVideoPath);
  }
  progress(15, 'Template preview downloaded');

  // Step 2: Probe template video untuk dapat dimensi & durasi
  progress(20, 'Probing template video');
  const probe = await probeVideo(tplVideoPath);
  logger.info({ probe }, 'Template video probed');
  const { width, height, duration: tplDuration } = probe;

  // Step 3: Pilih layout strategi
  const layoutMode = layout?.mode || (height > width ? 'cover-portrait' : 'cover-landscape');

  // Step 4: Prepare overlay filter
  progress(35, `Building overlay filter (mode=${layoutMode}, images=${imagePaths.length})`);

  // Strategy:
  // - Kalau 1 image: full-cover overlay, opacity 100%, hold until end
  // - Kalau 2+ images: split timeline equally, each image shows for tplDuration/N seconds
  const N = imagePaths.length;
  const segmentDur = tplDuration / N;
  // Build input args: template video + each image as -loop 1 -t <dur> (loop image for segment duration)
  const inputArgs = ['-i', tplVideoPath];
  for (const img of imagePaths) {
    inputArgs.push('-loop', '1', '-t', segmentDur.toFixed(3), '-i', img);
  }

  // Build filter_complex string
  // For each image:
  //   - scale to fit template dims (cover mode = scale + crop)
  //   - apply fade in/out
  //   - overlay onto base video with enable=between(start, end)
  //   - DO NOT use eof_action=endall (it stops entire output when overlay ends)
  //   - Use eof_action=repeat (continue showing last frame) or default
  const filterParts = [];
  let lastLabel = '[0:v]'; // base = template video

  for (let i = 0; i < N; i++) {
    const imgLabel = `[${i + 1}:v]`;
    const scaledLabel = `[s${i}]`;
    const fadedLabel = `[f${i}]`;
    const outLabel = `[o${i}]`;

    // Scale to template dimensions with "cover" mode (fill area, may crop)
    filterParts.push(
      `${imgLabel}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1${scaledLabel}`
    );

    // Apply fade in/out for smooth transitions (skip fade for last image's fade-out)
    const startSec = i * segmentDur;
    const endSec = (i + 1) * segmentDur;
    const fadeInDur = Math.min(0.3, segmentDur / 4);
    const fadeOutDur = Math.min(0.3, segmentDur / 4);

    if (i === N - 1) {
      // Last segment: fade in only (no fade out, hold until end)
      filterParts.push(
        `${scaledLabel}format=rgba,fade=in:st=0:d=${fadeInDur}:alpha=1,setpts=PTS-STARTPTS${fadedLabel}`
      );
    } else {
      filterParts.push(
        `${scaledLabel}format=rgba,fade=in:st=0:d=${fadeInDur}:alpha=1,fade=out:st=${segmentDur - fadeOutDur}:d=${fadeOutDur}:alpha=1,setpts=PTS-STARTPTS${fadedLabel}`
      );
    }

    // Overlay onto current base — enable only during segment time window
    // Use eof_action=pass (default) so base video continues after overlay ends
    filterParts.push(
      `${lastLabel}${fadedLabel}overlay=0:0:enable='between(t,${startSec.toFixed(3)},${endSec.toFixed(3)})'${outLabel}`
    );
    lastLabel = outLabel;
  }

  // Step 5: Run ffmpeg
  progress(55, 'Running ffmpeg overlay');
  const filterComplex = filterParts.join(';');
  const args = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', lastLabel,
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest', // stop at shortest input (template video duration)
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];

  logger.info({ cmd: 'ffmpeg ' + args.join(' ').slice(0, 500) }, 'Running ffmpeg');
  const { stdout, stderr } = await execFileAsync('ffmpeg', args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300000,
  });
  if (stderr) {
    const lastLines = stderr.split('\n').filter(Boolean).slice(-3);
    logger.debug({ lastLines }, 'ffmpeg stderr (last 3 lines)');
  }

  progress(90, 'Verifying output');

  // Step 6: Verify output
  const stat = await fs.stat(outputPath);
  if (stat.size < 1000) {
    throw new Error(`Output video too small (${stat.size} bytes). FFmpeg may have failed.`);
  }

  const outProbe = await probeVideo(outputPath);
  progress(100, 'Compose done');

  return {
    outputPath,
    durationSec: outProbe.duration,
    sizeBytes: stat.size,
    width: outProbe.width,
    height: outProbe.height,
  };
}

/**
 * Download a URL to a local file.
 */
async function downloadFile(url, destPath, { timeout = 60000 } = {}) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': 'https://www.capcut.com/',
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const writer = (await import('node:fs')).createWriteStream(destPath);
  res.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
    res.data.on('error', reject);
  });
}

/**
 * Probe video dimensions & duration with ffprobe.
 */
async function probeVideo(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration',
    '-of', 'json',
    filePath,
  ], { maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0] || {};
  return {
    width: parseInt(stream.width, 10) || 0,
    height: parseInt(stream.height, 10) || 0,
    duration: parseFloat(stream.duration) || 0,
  };
}

export default { composeTemplateVideo };
