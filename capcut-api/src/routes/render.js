// src/routes/render.js
import { Hono } from 'hono';
import { resolveImages } from '../services/input-handler.js';
import { createJob, enqueueJob, getJob, STATES } from '../services/job-manager.js';
import { runRenderJob } from '../services/render-worker.js';
import { parseMultipart } from '../utils/multipart.js';
import { logger } from '../utils/logger.js';

const app = new Hono();

/**
 * POST /render
 *
 * Body (JSON):
 *   {
 *     "template": "https://www.capcut.com/templates/detail/123" | "123" | {url},
 *     "imageUrls": ["https://...", "https://..."],
 *     "imagesBase64": ["data:image/png;base64,..."],
 *     "images": [{ "type": "url"|"base64", "value": "..." }]
 *   }
 *
 * Or multipart/form-data:
 *   - field template (string)
 *   - file[] (multiple files, fieldname bebas: images / files / upload)
 *
 * Response 202:
 *   { "jobId": "abc123", "status": "queued", "statusUrl": "/status/abc123" }
 */
app.post('/', async (c) => {
  let template;
  let imagePaths;
  let jsonBody = null;

  const contentType = c.req.header('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    // Parse multipart dari raw Node request
    const nodeReq = c.env.incoming;
    const { fields, files } = await parseMultipart(nodeReq);
    template = fields.template || fields.templateUrl || fields.templateId;
    jsonBody = fields; // field non-file
    imagePaths = await resolveImages({ jsonBody: null, files });
  } else {
    // JSON
    try {
      jsonBody = await c.req.json();
    } catch (e) {
      return c.json({ error: 'Invalid JSON body', detail: e.message }, 400);
    }
    template = jsonBody.template || jsonBody.templateUrl || jsonBody.templateId;
    imagePaths = await resolveImages({ jsonBody, files: null });
  }

  if (!template) {
    return c.json({ error: 'Template is required. Provide via "template", "templateUrl", or "templateId".' }, 400);
  }

  // Create job
  const job = createJob({
    template,
    imageCount: imagePaths.length,
    contentType,
  });

  const engine = (jsonBody && jsonBody.engine ? String(jsonBody.engine) : 'auto').toLowerCase();
  job.meta = { ...(job.meta || {}), engine };

  enqueueJob(job, async (j) => {
    await runRenderJob(j, { template, imagePaths, engine });
  });

  return c.json({
    jobId: job.id,
    status: job.status,
    statusUrl: `/render/status/${job.id}`,
    downloadUrl: `/render/download/${job.id}`,
  }, 202);
});

/**
 * GET /render/status/:jobId
 *
 * Response 200:
 *   {
 *     "jobId": "abc123",
 *     "status": "queued"|"running"|"completed"|"failed",
 *     "progress": 0-100,
 *     "message": "...",
 *     "videoUrl": "http://host/files/videos/xxx.mp4",  // hanya jika completed
 *     "error": null | "...",                            // hanya jika failed
 *     "createdAt": 1234567890,
 *     "updatedAt": 1234567890
 *   }
 */
app.get('/status/:jobId', (c) => {
  const job = getJob(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);

  return c.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    videoUrl: job.videoUrl,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
});

/**
 * GET /render/download/:jobId
 *
 * Redirect ke URL video (atau 409 kalau belum selesai / gagal)
 */
app.get('/download/:jobId', (c) => {
  const job = getJob(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.status !== STATES.COMPLETED) {
    return c.json({
      error: 'Job not completed yet',
      status: job.status,
      progress: job.progress,
      message: job.message,
    }, 409);
  }
  return c.redirect(job.videoUrl);
});

export default app;
