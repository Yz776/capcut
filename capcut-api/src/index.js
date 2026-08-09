// src/index.js
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';

import { config } from './utils/config.js';
import { ensureDirs } from './utils/paths.js';
import { logger } from './utils/logger.js';
import { startCleanupTimer } from './services/job-manager.js';

import renderRoutes from './routes/render.js';
import templateRoutes from './routes/templates.js';

// Ensure storage dirs
ensureDirs();
startCleanupTimer();

const app = new Hono();

// ============ Middleware: expose raw Node IncomingMessage ============
// Hono wraps Node request, but multipart parser needs raw req.
// We attach it to c.env via this middleware.
app.use('*', async (c, next) => {
  // @hono/node-server exposes c.env.incoming as the raw request
  if (!c.env) c.env = {};
  if (!c.env.incoming && c.req.raw) {
    // fallback: try to recover from web Request - but for multipart we need real Node stream
    // @hono/node-server already sets c.env.incoming automatically
  }
  await next();
});

// ============ Routes ============
app.get('/', (c) => c.json({
  name: 'CapCut JJ API',
  version: '1.0.0',
  endpoints: {
    'GET  /': 'This info',
    'GET  /health': 'Health check',
    'POST /render': 'Render video from template + images (async, returns jobId)',
    'GET  /render/status/:jobId': 'Check render job status',
    'GET  /render/download/:jobId': 'Redirect to rendered video URL',
    'GET  /templates': 'List popular CapCut templates',
    'GET  /templates/search?q=': 'Search templates by keyword',
    'GET  /templates/:id': 'Get template detail (id or url query)',
    'GET  /files/videos/:filename': 'Static serve rendered videos',
  },
  docs: 'See README.md for full API documentation.',
}));

app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime(), ts: Date.now() }));

app.route('/render', renderRoutes);
app.route('/templates', templateRoutes);

// Static serve for rendered videos & downloaded images
// Video: /files/videos/:filename -> /videos/:filename
app.use('/files/videos/*', serveStatic({ root: config.projectRoot, rewriteRequestPath: (p) => p.replace('/files/videos', '/videos') }));
app.use('/files/*', serveStatic({ root: config.projectRoot }));

// 404
app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404));

// Error handler
app.onError((err, c) => {
  // Validation errors -> 400
  if (err && (err.message?.includes('required') || err.message?.includes('At least'))) {
    return c.json({ error: 'Bad Request', detail: err.message }, 400);
  }
  logger.error({ err: err.message, stack: err.stack, path: c.req.path }, 'Unhandled error');
  return c.json({ error: 'Internal Server Error', detail: err.message }, 500);
});

// ============ Start server ============
serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
}, (info) => {
  logger.info(`CapCut JJ API listening on http://${config.host}:${config.port}`);
  logger.info(`Public base URL: ${config.publicBaseUrl}`);
  if (!config.capcut.email || !config.capcut.password) {
    logger.warn('CAPCUT_EMAIL/CAPCUT_PASSWORD not set. /render and /templates will fail at login step.');
  }
  logger.info(`Headless: ${config.browser.headless}, Concurrency: ${config.jobs.maxConcurrent}`);
});

// Graceful shutdown
const shutdown = (sig) => {
  logger.info({ sig }, 'Shutting down...');
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
