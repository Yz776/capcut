// src/services/render-worker.js
import { logger } from '../utils/logger.js';
import { CapCutBrowser } from './capcut-browser.js';
import { getTemplateInfo } from './capcut-api.js';
import { saveVideo, videoPublicUrl, sanitizeFilename } from '../utils/paths.js';

/**
 * Run render job end-to-end:
 * 1. (Skip axios) Get template info via API — cepat, no browser
 * 2. Launch browser
 * 3. Login
 * 4. Render template with images (editor)
 * 5. Save video to disk, generate public URL
 *
 * @param {Object} job - job object (from job-manager)
 * @param {Object} input - { template: {url} | {id} | {object}, imagePaths: string[] }
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

    // Step 1: Resolve template via axios API (no browser needed) - super cepat
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
      logger.warn({ err: e.message, jobId: job.id }, 'API template resolve failed, will try browser-based fallback');
      // Fallback: pakai input apa adanya
      template = typeof tplInput === 'string'
        ? { id: extractTemplateId(tplInput) || tplInput }
        : { id: tplInput?.id, editorUrl: tplInput?.editorUrl };
    }

    if (imagePaths.length < (template.imageSlots || 2)) {
      logger.warn({ have: imagePaths.length, need: template.imageSlots || 2 },
        'Fewer images than template slots - some slots will be reused');
    }

    // Step 2: Launch browser
    setProgress(8, 'Launching browser');
    await browser.launch();

    // Step 3: Login
    setProgress(15, 'Logging in to CapCut');
    await browser.login();

    // Step 4: Render
    setProgress(20, `Rendering template "${template.title || template.id}"`);
    const result = await browser.renderTemplate(template, imagePaths, {
      onProgress: (pct, msg) => setProgress(pct, msg),
    });

    // Step 5: Save & generate URL
    setProgress(98, 'Saving video');
    const filename = sanitizeFilename(template.title || job.id);
    const localPath = saveVideo(`${filename}_${job.id}`, result.videoBuffer, result.format);
    const publicUrl = videoPublicUrl(`${filename}_${job.id}`, result.format);

    job.videoPath = localPath;
    job.videoUrl = publicUrl;
    job.status = 'completed';
    job.progress = 100;
    job.message = 'Render completed successfully';
    job.updatedAt = Date.now();

    logger.info({ jobId: job.id, publicUrl, sizeKB: Math.round(result.videoBuffer.length / 1024) },
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
