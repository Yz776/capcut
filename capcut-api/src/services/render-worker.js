// src/services/render-worker.js
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { CapCutBrowser } from './capcut-browser.js';
import { saveVideo, videoPublicUrl, sanitizeFilename } from '../utils/paths.js';

/**
 * Run render job end-to-end:
 * 1. Launch browser
 * 2. Login
 * 3. Get template (if URL/ID provided) OR use template object directly
 * 4. Render template with images
 * 5. Save video to disk, generate public URL
 *
 * @param {Object} job - job object (from job-manager)
 * @param {Object} input - { template: {url} | {id} | {object}, imagePaths: string[] }
 */
export async function runRenderJob(job, input) {
  const { template: tplInput, imagePaths } = input;
  const browser = new CapCutBrowser();

  try {
    // Update job helper
    const setProgress = (pct, msg) => {
      job.progress = pct;
      job.message = msg;
      job.updatedAt = Date.now();
    };

    setProgress(2, 'Launching browser');
    await browser.launch();

    setProgress(8, 'Logging in to CapCut');
    await browser.login();

    let template;
    if (typeof tplInput === 'string') {
      setProgress(15, 'Fetching template');
      template = await browser.getTemplate(tplInput);
    } else if (tplInput?.url) {
      setProgress(15, 'Fetching template');
      template = await browser.getTemplate(tplInput.url);
    } else if (tplInput?.id) {
      setProgress(15, 'Fetching template');
      template = await browser.getTemplate(tplInput.id);
    } else if (tplInput?.useTemplateAvailable) {
      // already-resolved template object from list/search
      template = tplInput;
    } else {
      throw new Error('Invalid template input. Provide url, id, or full template object.');
    }

    if (imagePaths.length < template.imageSlots) {
      logger.warn({ have: imagePaths.length, need: template.imageSlots },
        'Fewer images than template slots - some slots will be reused');
    }

    setProgress(20, `Rendering template "${template.title}"`);
    const result = await browser.renderTemplate(template, imagePaths, {
      onProgress: (pct, msg) => setProgress(pct, msg),
    });

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

export default runRenderJob;
