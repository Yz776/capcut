// src/utils/paths.js
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/** Ensure all storage directories exist */
export function ensureDirs() {
  for (const d of [
    config.storage.downloadDir,
    config.storage.videoDir,
    config.storage.tmpDir,
    path.join(config.storage.tmpDir, 'images'),
    path.join(config.projectRoot, 'logs'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Save a buffer to videoDir, returns absolute path */
export function saveVideo(jobId, buffer, ext = 'mp4') {
  const file = path.join(config.storage.videoDir, `${jobId}.${ext}`);
  fs.writeFileSync(file, buffer);
  return file;
}

/** Public URL for a video file served via /files/videos/* */
export function videoPublicUrl(jobId, ext = 'mp4') {
  return `${config.publicBaseUrl}/files/videos/${jobId}.${ext}`;
}

/** Random sleep helper */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Sanitize filename */
export function sanitizeFilename(s) {
  return s.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80);
}
