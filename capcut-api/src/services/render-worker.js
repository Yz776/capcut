// src/services/render-worker.js
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { CapCutBrowser } from './capcut-browser.js';
import { getTemplateInfo } from './capcut-api.js';
import { composeTemplateVideo } from './video-composer.js';
import { saveVideo, videoPublicUrl, sanitizeFilename } from '../utils/paths.js';

/**
 * Run render job end-to-end.
 * Strategy:
 *   1. Resolve template info via axios (cheap, no browser)
 *   2. Coba render via CapCut editor (full automation, needs valid editor session)
 *   3. Kalau editor auth gagal → fallback ke ffmpeg composer (overlay images to template preview)
 *   4. Save video & generate URL
 *
 * @param {Object} job - job object (from job-manager)
 * @param {Object} input - { template, imagePaths }
 */
export async function runRenderJob(job, input) {
  const { template: tplInput, imagePaths } = input;
  const browser = new CapCutBrowser();

  try {
    const setProgress = (pct, msg) => {
      job.progress = pct;
      job.message = msg;
      job.updatedAt = Date.now();
    };

    // Step 1: Resolve template via axios API
    setProgress(2, 'Resolving template info');
    let template;
    try {
      const templateId = extractTemplateId(tplInput);
      if (templateId) {
        template = await getTemplateInfo(templateId);
        logger.info({ jobId: job.id, templateId, title: template.title, slots: template.imageSlots },
          'Template resolved via API');
      } else {
        throw new Error(`Cannot extract template ID from input: ${JSON.stringify(tplInput).slice(0, 100)}`);
      }
    } catch (e) {
      logger.warn({ err: e.message, jobId: job.id }, 'API template resolve failed, fallback to raw input');
      template = typeof tplInput === 'string'
        ? { id: extractTemplateId(tplInput) || tplInput }
        : { id: tplInput?.id, editorUrl: tplInput?.editorUrl };
    }

    if (imagePaths.length < (template.imageSlots || 2)) {
      logger.warn({ have: imagePaths.length, need: template.imageSlots || 2 },
        'Fewer images than template slots - some slots will be reused');
    }

    if (!template.videoUrl) {
      throw new Error('Template tidak punya preview videoUrl. Tidak bisa render (butuh URL preview untuk ffmpeg fallback).');
    }

    const filename = sanitizeFilename(template.title || job.id);

    // Step 2: Try CapCut editor render first (only if enabled + userDataDir set)
    let result = null;
    let editorError = null;
    const canTryEditor = config.browser.editorEnabled && config.browser.userDataDir;

    if (canTryEditor) {
      try {
        setProgress(8, 'Launching browser for CapCut editor');
        await browser.launch();
        setProgress(15, 'Logging in to CapCut');
        await browser.login();
        setProgress(20, `Rendering via CapCut editor: "${template.title || template.id}"`);
        result = await browser.renderTemplate(template, imagePaths, {
          onProgress: (pct, msg) => setProgress(pct, msg),
        });
        logger.info({ jobId: job.id }, 'CapCut editor render succeeded');
      } catch (e) {
        editorError = e;
        logger.warn({ jobId: job.id, err: e.message },
          'CapCut editor render failed — falling back to ffmpeg composer');
      } finally {
        await browser.close();
      }
    } else {
      logger.info({ jobId: job.id, editorEnabled: config.browser.editorEnabled, hasUserDataDir: !!config.browser.userDataDir },
        'CapCut editor disabled — using ffmpeg composer directly');
    }

    // Step 3: Fallback ke ffmpeg composer
    if (!result) {
      setProgress(30, 'Using ffmpeg fallback (CapCut editor unavailable)');
      logger.info({ jobId: job.id, editorError: editorError?.message },
        'Starting ffmpeg-based composition');

      const outPath = path.join(config.storage.videoDir, `${filename}_${job.id}.mp4`);

      const composeResult = await composeTemplateVideo({
        template,
        imagePaths,
        outputPath: outPath,
        onProgress: (pct, msg) => setProgress(30 + Math.floor(pct * 0.6), `[ffmpeg] ${msg}`),
      });

      const videoBuffer = await readFile(composeResult.outputPath);
      result = {
        videoBuffer,
        videoUrl: null,
        format: 'mp4',
        source: 'ffmpeg-fallback',
        editorError: editorError?.message,
      };
    }

    // Step 4: Save & generate URL (skip if already on disk via ffmpeg)
    setProgress(95, 'Saving video');
    let localPath;
    let publicUrl;

    if (result.source === 'ffmpeg-fallback') {
      // ffmpeg sudah tulis ke disk dengan nama yang benar
      localPath = path.join(config.storage.videoDir, `${filename}_${job.id}.mp4`);
      publicUrl = videoPublicUrl(`${filename}_${job.id}`, result.format);
    } else {
      // CapCut editor — buffer dari URL, perlu save ke disk
      localPath = saveVideo(`${filename}_${job.id}`, result.videoBuffer, result.format);
      publicUrl = videoPublicUrl(`${filename}_${job.id}`, result.format);
    }

    job.videoPath = localPath;
    job.videoUrl = publicUrl;
    job.renderSource = result.source || 'capcut-editor';
    job.status = 'completed';
    job.progress = 100;
    job.message = 'Render completed successfully';
    job.updatedAt = Date.now();

    logger.info({ jobId: job.id, publicUrl, sizeKB: Math.round(result.videoBuffer.length / 1024), source: job.renderSource },
      'Render job completed');
  } catch (err) {
    logger.error({ jobId: job.id, err: err.message, stack: err.stack }, 'Render job failed');
    job.status = 'failed';
    job.error = err.message;
    job.updatedAt = Date.now();
    throw err;
  } finally {
    await browser.close();
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
