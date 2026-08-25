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

// CORS — API-first (bisa dipanggil dari frontend / n8n / script)
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

// ============ Routes ============
app.get('/', (c) => c.json({
  name: 'CapCut API',
  version: '3.0.0',
  status: 'ok',
  docs: 'https://github.com/Yz776/capcut',
  endpoints: {
    health: { method: 'GET', path: '/health' },
    login: {
      method: 'POST',
      path: '/login',
      body: '{ "cookies": [...] } | { "cookieHeader": "..." }',
    },
    loginStatus: { method: 'GET', path: '/login/status' },
    templates: { method: 'GET', path: '/templates' },
    templatesSearch: { method: 'GET', path: '/templates/search?q=' },
    templateDetail: { method: 'GET', path: '/templates/:id' },
    render: {
      method: 'POST',
      path: '/render',
      body: '{ "template": "<id|url>", "imageUrls": ["..."] }',
      response: '202 { jobId, statusUrl, downloadUrl }',
    },
    renderStatus: { method: 'GET', path: '/render/status/:jobId' },
    renderDownload: { method: 'GET', path: '/render/download/:jobId' },
    renderDirect: {
      method: 'POST',
      path: '/render-direct',
      note: 'experimental pure-API path',
    },
    files: { method: 'GET', path: '/files/videos/:filename' },
  },
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
  logger.info(`Profile dir: ${config.browser.userDataDir}`);
  // Cek cookies.json — tanpa ini /render & /render-direct butuh login dulu
  try {
    const cookiePath = path.join(config.browser.userDataDir, 'cookies.json');
    if (fs.existsSync(cookiePath)) {
      logger.info('cookies.json found — session siap untuk /render dan /render-direct');
    } else {
      logger.warn(
        'cookies.json belum ada. Buka /login di browser, paste cookies dari CapCut yang sudah login, ' +
        'baru /render bisa jalan.'
      );
    }
  } catch (_) {}
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
