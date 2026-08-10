// src/index.js
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

import { config } from './utils/config.js';
import { ensureDirs } from './utils/paths.js';
import { logger } from './utils/logger.js';
import { startCleanupTimer } from './services/job-manager.js';

import renderRoutes from './routes/render.js';
import templateRoutes from './routes/templates.js';
import loginRoutes from './routes/login.js';
import directRenderRoutes from './routes/direct-render.js';

// Ensure storage dirs
ensureDirs();
startCleanupTimer();

const app = new Hono();

// ============ Middleware: expose raw Node IncomingMessage ============
// Hono wraps Node request, but multipart parser needs raw req.
app.use('*', async (c, next) => {
  if (!c.env) c.env = {};
  await next();
});

// ============ Routes ============
app.get('/', (c) => c.json({
  name: 'CapCut JJ API',
  version: '2.0.0',
  status: 'running',
  endpoints: {
    'GET  /': 'This info',
    'GET  /health': 'Health check',
    'GET  /login': 'Login form (HTML) for cookie paste',
    'GET  /login/status': 'Check current session status',
    'POST /login': 'Submit cookies (JSON: {cookies:[...]} | {cookieHeader:"..."} | {netscape:"..."})',
    'POST /login/manual': 'Start interactive browser for manual login (Xvfb)',
    'POST /render': 'Render video from template + images via browser editor (async)',
    'GET  /render/status/:jobId': 'Check render job status',
    'GET  /render/download/:jobId': 'Redirect to rendered video URL',
    'POST /render-direct': 'Render video via pure API (no browser) — async',
    'GET  /render-direct/status/:jobId': 'Check direct-render job status',
    'GET  /templates': 'List popular CapCut templates',
    'GET  /templates/search?q=': 'Search templates by keyword',
    'GET  /templates/:id': 'Get template detail (id or url query)',
    'GET  /files/videos/:filename': 'Static serve rendered videos',
  },
  quickStart: [
    '1. Open http://localhost:' + config.port + '/login in browser',
    '2. Paste cookies from logged-in CapCut session',
    '3. POST /render with template + images to render video',
  ],
}));

app.get('/health', (c) => c.json({
  status: 'ok',
  uptime: process.uptime(),
  ts: Date.now(),
  pid: process.pid,
  memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
}));

app.route('/login', loginRoutes);
app.route('/render', renderRoutes);
app.route('/render-direct', directRenderRoutes);
app.route('/templates', templateRoutes);

// Static serve for rendered videos & downloaded images
app.use('/files/videos/*', serveStatic({ root: config.projectRoot, rewriteRequestPath: (p) => p.replace('/files/videos', '/videos') }));
app.use('/files/*', serveStatic({ root: config.projectRoot }));

// 404
app.notFound((c) => c.json({ error: 'Not Found', path: c.req.path }, 404));

// Error handler
app.onError((err, c) => {
  if (err && (err.message?.includes('required') || err.message?.includes('At least'))) {
    return c.json({ error: 'Bad Request', detail: err.message }, 400);
  }
  logger.error({ err: err.message, stack: err.stack, path: c.req.path }, 'Unhandled error');
  return c.json({ error: 'Internal Server Error', detail: err.message }, 500);
});

// ============ Start server ============
// Auto-find available port if default is busy (7000 → 3002-3010 fallback)
function findPort(preferred, ...fallbacks) {
  return new Promise((resolve) => {
    const tryPort = (port, ...rest) => {
      const tester = net.createServer();
      tester.once('error', () => {
        if (rest.length > 0) tryPort(...rest);
        else resolve(preferred); // last resort
      });
      tester.once('listening', () => {
        tester.close(() => resolve(port));
      });
      tester.listen(port, config.host);
    };
    tryPort(preferred, ...fallbacks);
  });
}

const PORT = await findPort(config.port, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010);

serve({
  fetch: app.fetch,
  port: PORT,
  hostname: config.host,
}, (info) => {
  logger.info(`CapCut JJ API listening on http://${config.host}:${PORT}`);
  logger.info(`Login form: http://localhost:${PORT}/login`);
  if (!config.browser.userDataDir) {
    logger.warn(
      'CAPCUT_USER_DATA_DIR not set. /render will fail at login step. ' +
      'Open /login in browser to refresh session.'
    );
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

// Catch unhandled errors so the server doesn't die silently
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'UNCAUGHT EXCEPTION — server continuing');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason?.message || reason), stack: reason?.stack }, 'UNHANDLED REJECTION — server continuing');
});

export default app;
