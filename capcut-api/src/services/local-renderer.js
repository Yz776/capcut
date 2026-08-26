/**
 * Local FFmpeg renderer — guaranteed MP4 from images (fallback / engine=local).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

function run(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * @param {string[]} imagePaths
 * @returns {Promise<{videoPath: string, durationSec: number, size: number}>}
 */
export async function renderLocalVideo(imagePaths, {
  outDir = config.storage.videoDir,
  width = 1080,
  height = 1920,
  secondsPerImage = 2.5,
  transitionSec = 0.4,
  fps = 30,
  videoName = 'local-render',
  onProgress,
} = {}) {
  if (!imagePaths?.length) throw new Error('imagePaths required');
  fs.mkdirSync(outDir, { recursive: true });
  const id = randomBytes(6).toString('hex');
  const outPath = path.join(outDir, `${String(videoName).replace(/[^\w.-]+/g, '_')}-${id}.mp4`);
  const n = imagePaths.length;
  const dur = secondsPerImage;
  const xf = Math.min(transitionSec, dur / 2);

  onProgress?.(10, 'Building FFmpeg graph');

  const inputs = [];
  for (const p of imagePaths) {
    inputs.push('-loop', '1', '-t', String(dur), '-i', p);
  }

  const filters = [];
  for (let i = 0; i < n; i++) {
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},setsar=1,fps=${fps},format=yuv420p[v${i}]`
    );
  }

  if (n === 1) {
    filters.push(`[v0]null[vfinal]`);
  } else {
    let last = 'v0';
    let offset = dur - xf;
    for (let i = 1; i < n; i++) {
      const out = i === n - 1 ? 'vfinal' : `vx${i}`;
      filters.push(
        `[${last}][v${i}]xfade=transition=fade:duration=${xf}:offset=${offset.toFixed(3)}[${out}]`
      );
      last = out;
      offset += dur - xf;
    }
  }

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vfinal]',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    outPath,
  ];

  onProgress?.(40, 'Encoding video');
  logger.info({ n, outPath, width, height }, 'local-renderer: ffmpeg start');
  await run('ffmpeg', args);
  onProgress?.(100, 'Done');

  const st = fs.statSync(outPath);
  if (st.size < 1000) throw new Error('ffmpeg produced empty file');
  const durationSec = n === 1 ? dur : n * dur - (n - 1) * xf;
  logger.info({ outPath, size: st.size, durationSec }, 'local-renderer: done');
  return { videoPath: outPath, durationSec, size: st.size };
}

export default { renderLocalVideo };
