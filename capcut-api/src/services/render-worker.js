// src/services/render-worker.js
//
// Render pipeline (editor-only — no ffmpeg fallback):
//   1. Resolve template info via axios (cheap, no browser).
//   2. Launch CapCut editor in Puppeteer, login via persistent userDataDir
//      (or email/password — but persistent session is the only reliable path).
//   3. Open editor-template?create_id=<id>, upload user images, click Export,
//      wait for the rendered MP4 URL, download the buffer.
//   4. Save buffer to disk and expose a public URL via /files/videos/*.
//
// If login is missing/expired, the job fails fast with an actionable message
// instructing the user to run `npm run login:manual`.

import path from 'node:path';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import fs from 'node:fs';
import { CapCutBrowser } from './capcut-browser.js';
import { renderLocalVideo } from './local-renderer.js';
import { getTemplateInfo } from './capcut-api.js';
import { saveVideo, videoPublicUrl, sanitizeFilename } from '../utils/paths.js';

/**
 * Run render job end-to-end (CapCut editor only).
 *
 * @param {Object} job - job object (from job-manager)
 * @param {Object} input - { template, imagePaths }
 */
export async function runRenderJob(job, input) {
  const { template: tplInput, imagePaths, engine = 'auto' } = input;
  const browser = new CapCutBrowser();

  const setProgress = (pct, msg) => {
    job.progress = pct;
    job.message = msg;
    job.updatedAt = Date.now();
  };

  if (engine === 'local' || engine === 'ffmpeg') {
    setProgress(10, 'Local FFmpeg render');
    const local = await renderLocalVideo(imagePaths, {
      videoName: String(typeof tplInput === 'string' ? tplInput : (tplInput?.id || job.id)).slice(0, 40),
      onProgress: setProgress,
    });
    const buf = fs.readFileSync(local.videoPath);
    const filename = sanitizeFilename(String(typeof tplInput === 'string' ? tplInput : (tplInput?.title || job.id)));
    const localPath = saveVideo(`${filename}_${job.id}`, buf, 'mp4');
    job.videoPath = localPath;
    job.videoUrl = videoPublicUrl(`${filename}_${job.id}`, 'mp4');
    job.renderSource = 'local-ffmpeg';
    job.status = 'completed';
    job.progress = 100;
    job.message = 'Render completed (local FFmpeg)';
    job.updatedAt = Date.now();
    return;
  }

  try {

    // Step 1: Resolve template via axios API (best-effort — enriches editorUrl & title)
    setProgress(2, 'Resolving template info');
    let template;
    try {
      const templateId = extractTemplateId(tplInput);
      if (templateId) {
        template = await getTemplateInfo(templateId);
        logger.info(
          { jobId: job.id, templateId, title: template.title, slots: template.imageSlots },
          'Template resolved via API'
        );
      } else {
        throw new Error(
          `Cannot extract template ID from input: ${JSON.stringify(tplInput).slice(0, 100)}`
        );
      }
    } catch (e) {
      logger.warn({ err: e.message, jobId: job.id }, 'API template resolve failed, fallback to raw input');
      template = typeof tplInput === 'string'
        ? { id: extractTemplateId(tplInput) || tplInput }
        : { id: tplInput?.id, editorUrl: tplInput?.editorUrl };
    }

    if (!template.id && !template.editorUrl) {
      throw new Error(
        'Template tidak punya id atau editorUrl. Tidak bisa lanjut ke CapCut editor.'
      );
    }

    // Step 2: Editor render (the only render path)
    setProgress(8, 'Launching browser for CapCut editor');
    await browser.launch();

    setProgress(15, 'Logging in to CapCut');
    await browser.login();

    setProgress(20, `Rendering via CapCut editor: "${template.title || template.id}"`);
    const result = await browser.renderTemplate(template, imagePaths, {
      onProgress: (pct, msg) => setProgress(pct, msg),
    });
    logger.info({ jobId: job.id }, 'CapCut editor render succeeded');

    // Step 3: Save & generate public URL
    setProgress(95, 'Saving video');
    const filename = sanitizeFilename(template.title || job.id);
    const localPath = saveVideo(`${filename}_${job.id}`, result.videoBuffer, result.format);
    const publicUrl = videoPublicUrl(`${filename}_${job.id}`, result.format);

    job.videoPath = localPath;
    job.videoUrl = publicUrl;
    job.renderSource = 'capcut-editor';
    job.status = 'completed';
    job.progress = 100;
    job.message = 'Render completed successfully';
    job.updatedAt = Date.now();

    logger.info(
      { jobId: job.id, publicUrl, sizeKB: Math.round(result.videoBuffer.length / 1024) },
      'Render job completed'
    );
  } catch (err) {
    logger.error({ jobId: job.id, err: err.message, stack: err.stack }, 'CapCut render failed — trying local FFmpeg fallback');
    try {
      await browser.close().catch(() => {});
    } catch (_) {}
    // Guaranteed path: local FFmpeg
    try {
      setProgress(30, 'CapCut failed; falling back to local renderer');
      const local = await renderLocalVideo(imagePaths, {
        videoName: String(template?.title || template?.id || job.id).slice(0, 40),
        onProgress: (pct, msg) => setProgress(30 + Math.floor(pct * 0.65), msg),
      });
      const buf = fs.readFileSync(local.videoPath);
      const filename = sanitizeFilename(template?.title || job.id);
      const localPath = saveVideo(`${filename}_${job.id}`, buf, 'mp4');
      const publicUrl = videoPublicUrl(`${filename}_${job.id}`, 'mp4');
      job.videoPath = localPath;
      job.videoUrl = publicUrl;
      job.renderSource = 'local-ffmpeg-fallback';
      job.capcutError = err.message;
      job.status = 'completed';
      job.progress = 100;
      job.message = 'Completed via local FFmpeg fallback (CapCut path failed)';
      job.updatedAt = Date.now();
      logger.info({ jobId: job.id, publicUrl, source: 'local-ffmpeg' }, 'Render completed via fallback');
      return;
    } catch (localErr) {
      logger.error({ jobId: job.id, err: localErr.message }, 'Local fallback also failed');
      job.status = 'failed';
      let msg = `CapCut: ${err.message} | Local: ${localErr.message}`;
      if (/session|login|cookie|not logged/i.test(err.message)) {
        msg += ' → Buka /login, paste cookies CapCut yang valid, lalu retry.';
      }
      job.error = msg;
      job.message = msg;
      job.updatedAt = Date.now();
      throw new Error(msg);
    }
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

function extractTemplateId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{15,25}$/.test(s)) return s;
  let m = s.match(/\/template-detail\/[^/]+\/(\d+)/);
  if (m) return m[1];
  m = s.match(/\/template-detail\/(\d+)/);
  if (m) return m[1];
  m = s.match(/create_id[=](\d+)/);
  if (m) return m[1];
  m = s.match(/(\d{15,25})/);
  if (m) return m[1];
  return null;
}

export default runRenderJob;
