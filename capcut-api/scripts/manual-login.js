// scripts/manual-login.js
// CapCut manual login — works on HEADLESS servers (no X server / no display).
//
// Strategi (v2 — robust, self-diagnosing):
// 1. Launch Chromium dalam headless mode (modern headless, bukan old headless).
// 2. Buka https://www.capcut.com/login
// 3. JALANKAN HTTP server DI SINI, SEBELUM browser launch — supaya user ALWAYS
//    bisa akses / dashboard bahkan kalau browser gagal launch.
// 4. Screenshot SEMUA page + SEMUA frame setiap 1.5s, simpan yang "paling QR-like"
//    ke tmp/qr-latest.png. Juga simpan screenshot per-page untuk debug.
// 5. Dashboard di / menampilkan: status lengkap, screenshot utama, screenshot
//    semua popup, log terbaru, hint apa yg sedang dilakukan script.
// 6. Poll untuk detect login (cookies, URL change, avatar element).
// 7. Setelah login terdeteksi → session disimpan ke .capcut-profile/.
//
// Cara pakai di server headless:
//   npm run login:manual
//   # SSH tunnel dari laptop: ssh -L 3001:localhost:3001 root@<server> -p <port>
//   # buka http://localhost:3001/ di browser lokal → scan QR pake CapCut HP
//
// Port fallback otomatis: kalau 3001 sibuk, coba 3002..3010.

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = config.projectRoot || path.resolve(__dirname, '..');

const userDataDir = path.resolve(projectRoot, '.capcut-profile');
const tmpDir = path.join(projectRoot, 'tmp');
const screenshotDir = path.join(tmpDir, 'login-screenshots');
const qrLatestPath = path.join(tmpDir, 'qr-latest.png');
const mainPageShotPath = path.join(tmpDir, 'main-page.png');
const statusJsonPath = path.join(tmpDir, 'login-status.json');
fs.mkdirSync(screenshotDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });
fs.rmSync(qrLatestPath, { force: true });

// Clean up stale SingletonLock from previous crashed chrome instance
for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  const lockPath = path.join(userDataDir, lockFile);
  try { fs.rmSync(lockPath, { force: true }); } catch (_) {}
}

// ====== Konfigurasi ======
const PREFERRED_PORT = parseInt(process.env.CAPCUT_LOGIN_PORT || '3001', 10);
const POLL_INTERVAL_MS = 1500;
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 menit
const hasDisplay = !!process.env.DISPLAY && process.env.DISPLAY.length > 0;

// ====== Global status (dipakai dashboard) ======
const status = {
  bootTime: Date.now(),
  browserLaunched: false,
  loginPageLoaded: false,
  mobileButtonFound: false,
  mobileButtonClicked: false,
  popupOpened: false,
  qrDetected: false,
  loginDetected: false,
  currentPhase: 'starting',         // starting | launching-browser | loading-page | finding-button | clicking | waiting-qr | waiting-login | success | timeout | error
  currentUrl: '',
  popupUrl: '',
  pageCount: 0,
  frameCount: 0,
  iframeCount: 0,
  canvasCount: 0,
  dialogCount: 0,
  cookieCount: 0,
  hasSessionCookie: false,
  lastError: '',
  actualHttpPort: null,
  lastButtonClick: null,
  recentLogs: [],   // [{ts, level, msg}]
  screenshots: [],  // [{name, path, mtime, size, kind}]
};

function pushLog(level, msg, extra) {
  const entry = { ts: new Date().toISOString(), level, msg: String(msg).slice(0, 200), extra: extra ? JSON.stringify(extra).slice(0, 200) : '' };
  status.recentLogs.push(entry);
  if (status.recentLogs.length > 30) status.recentLogs.shift();
}

// Wrap logger to also capture into status.recentLogs
const origInfo = logger.info.bind(logger);
const origWarn = logger.warn.bind(logger);
const origError = logger.error.bind(logger);
logger.info = (objOrMsg, msg) => { if (msg) pushLog('info', msg, objOrMsg); else pushLog('info', objOrMsg); return origInfo(objOrMsg, msg); };
logger.warn = (objOrMsg, msg) => { if (msg) pushLog('warn', msg, objOrMsg); else pushLog('warn', objOrMsg); return origWarn(objOrMsg, msg); };
logger.error = (objOrMsg, msg) => { if (msg) pushLog('error', msg, objOrMsg); else pushLog('error', objOrMsg); return origError(objOrMsg, msg); };

function setStatus(phase, extra = {}) {
  status.currentPhase = phase;
  Object.assign(status, extra);
}

// Save status ke file supaya dashboard bisa baca (selain in-memory)
function persistStatus() {
  try {
    fs.writeFileSync(statusJsonPath, JSON.stringify({
      ...status,
      screenshots: status.screenshots.slice(-12),
      recentLogs: status.recentLogs.slice(-30),
    }, null, 2));
  } catch (_) {}
}

// ====== Helper: cari port kosong ======
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => { tester.close(() => resolve(true)); });
    tester.listen(port, '0.0.0.0');
  });
}

async function findFreePort(preferred) {
  for (let p = preferred; p <= preferred + 9; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

const HTTP_PORT = await findFreePort(PREFERRED_PORT);
if (HTTP_PORT === null) {
  console.error(`All ports ${PREFERRED_PORT}-${PREFERRED_PORT + 9} are busy. Set CAPCUT_LOGIN_PORT to a free port.`);
  process.exit(1);
}
status.actualHttpPort = HTTP_PORT;
if (HTTP_PORT !== PREFERRED_PORT) {
  logger.warn(
    { preferred: PREFERRED_PORT, actual: HTTP_PORT },
    `Port ${PREFERRED_PORT} busy, using port ${HTTP_PORT} instead.`
  );
}

logger.info({
  userDataDir,
  hasDisplay,
  headless: !hasDisplay,
  httpPort: HTTP_PORT,
}, 'Manual login mode (headless Chromium + HTTP QR viewer)');

// ====== HTTP server — JALANKAN DULU, sebelum browser launch ======
const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // CORS + no-cache headers supaya dashboard auto-refresh reliable
  const noCacheHeaders = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  };

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...noCacheHeaders });
    res.end(dashboardHtml());
    return;
  }

  if (url === '/qr') {
    // Prioritas: qr-latest.png (hasil scan QR-like), fallback main-page.png
    const candidates = [qrLatestPath, mainPageShotPath];
    let chosen = null;
    for (const p of candidates) {
      if (fs.existsSync(p) && fs.statSync(p).size > 1000) { chosen = p; break; }
    }
    if (!chosen) {
      // Fallback: serve 1x1 png biar <img> tidak error
      res.writeHead(200, { 'Content-Type': 'image/png', ...noCacheHeaders });
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=', 'base64'));
      return;
    }
    const stat = fs.statSync(chosen);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      ...noCacheHeaders,
    });
    fs.createReadStream(chosen).pipe(res);
    return;
  }

  if (url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...noCacheHeaders });
    res.end(JSON.stringify({ ...status, screenshots: status.screenshots.slice(-12), recentLogs: status.recentLogs.slice(-30) }, null, 2));
    return;
  }

  if (url === '/shot') {
    // Serve screenshot by name (?name=main-page.png)
    const name = (req.url.split('?')[1] || '').split('=')[1] || '';
    const safe = path.basename(name);
    const p = path.join(tmpDir, safe);
    if (!fs.existsSync(p)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const stat = fs.statSync(p);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size, ...noCacheHeaders });
    fs.createReadStream(p).pipe(res);
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: HTTP_PORT, qrReady: fs.existsSync(qrLatestPath), phase: status.currentPhase }));
    return;
  }

  if (url === '/debug-bundle') {
    // Returns a JSON file with all debug info base64-encoded — user can download
    // and send to developer for diagnosis. No zip dep needed.
    persistStatus();
    const bundle = {
      generatedAt: new Date().toISOString(),
      status,
      files: {},
    };
    // Include all tracked screenshots + qr-latest + main-page + status json
    const filesToBundle = [
      { name: 'qr-latest.png', path: qrLatestPath },
      { name: 'main-page.png', path: mainPageShotPath },
      { name: 'status.json', path: statusJsonPath },
    ];
    for (const s of status.screenshots) {
      filesToBundle.push({ name: s.name, path: s.path });
    }
    for (const f of filesToBundle) {
      try {
        if (fs.existsSync(f.path)) {
          const buf = fs.readFileSync(f.path);
          bundle.files[f.name] = {
            size: buf.length,
            contentType: f.name.endsWith('.json') ? 'application/json' : 'image/png',
            base64: buf.toString('base64'),
          };
        }
      } catch (_) {}
    }
    const json = JSON.stringify(bundle, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="capcut-login-debug-${Date.now()}.json"`,
      ...noCacheHeaders,
    });
    res.end(json);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found. Try / or /qr or /status or /debug-bundle');
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  logger.info(`HTTP dashboard listening on http://0.0.0.0:${HTTP_PORT}/`);
  logger.info('──── INSTRUKSI LOGIN ────');
  logger.info(`1. Di laptop, buka SSH tunnel ke server ini:`);
  logger.info(`     ssh -L ${HTTP_PORT}:localhost:${HTTP_PORT} <user>@<server-host> -p <ssh-port>`);
  logger.info(`2. Di browser lokal, buka: http://localhost:${HTTP_PORT}/`);
  logger.info(`3. Tunggu sampai QR code muncul di dashboard. Scan pake aplikasi CapCut di HP:`);
  logger.info(`     Buka CapCut di HP → Profile (tab kanan) → icon Scan di kanan atas`);
  logger.info(`4. Script akan auto-detect login & save session ke ${userDataDir}`);
  logger.info('─────────────────────────');
});

httpServer.on('error', (e) => {
  logger.error({ err: e.message }, 'HTTP server error');
  process.exit(1);
});

// ====== Dashboard HTML ======
function dashboardHtml() {
  const uptimeS = Math.round((Date.now() - status.bootTime) / 1000);
  const phaseLabel = {
    'starting': 'Starting…',
    'launching-browser': 'Launching Chromium…',
    'loading-page': 'Loading CapCut login page…',
    'finding-button': 'Finding "Continue with CapCut Mobile" button…',
    'clicking': 'Clicking mobile login button…',
    'waiting-qr': 'Waiting for QR code to appear…',
    'waiting-login': 'QR ready — waiting for you to scan with CapCut mobile app',
    'success': '✓ Login successful! Session saved.',
    'timeout': '✗ Timeout — no login detected in 10 minutes.',
    'error': '✗ Error occurred. Check logs below.',
  }[status.currentPhase] || status.currentPhase;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>CapCut Login Dashboard</title>
<meta http-equiv="refresh" content="3">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f0f10;color:#eee;font-family:system-ui,-apple-system,sans-serif;padding:20px;min-height:100vh}
  .wrap{max-width:1100px;margin:0 auto}
  h1{font-size:22px;margin-bottom:4px;color:#fff}
  .sub{opacity:.6;font-size:13px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
  @media(max-width:760px){.grid{grid-template-columns:1fr}}
  .card{background:#1a1a1e;border:1px solid #2a2a2e;border-radius:10px;padding:14px 16px}
  .card h2{font-size:14px;margin-bottom:10px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
  .kv{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #232327}
  .kv:last-child{border-bottom:none}
  .kv .k{opacity:.6}
  .kv .v{font-family:monospace;color:#e5e7eb}
  .phase{font-size:15px;padding:10px 14px;border-radius:8px;background:#1f2937;color:#93c5fd;margin-bottom:16px;border-left:3px solid #3b82f6}
  .phase.success{background:#1a3a1a;color:#7fff7f;border-left-color:#22c55e}
  .phase.timeout{background:#3a1a1a;color:#ff7f7f;border-left-color:#ef4444}
  .phase.error{background:#3a1a1a;color:#ff7f7f;border-left-color:#ef4444}
  .qr-wrap{background:#fff;padding:12px;border-radius:10px;display:inline-block;text-align:center;width:100%}
  .qr-wrap img{display:block;max-width:100%;height:auto;margin:0 auto;image-rendering:pixelated;min-height:200px}
  .logs{background:#0a0a0c;border:1px solid #1f1f23;border-radius:8px;padding:10px;max-height:280px;overflow-y:auto;font-family:monospace;font-size:11px;line-height:1.5}
  .log-line{padding:1px 0;word-break:break-all;white-space:pre-wrap}
  .log-line.info{color:#cbd5e1}
  .log-line.warn{color:#fbbf24}
  .log-line.error{color:#f87171}
  .log-ts{opacity:.4;margin-right:6px}
  .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;margin-top:8px}
  .thumb{background:#0a0a0c;border:1px solid #1f1f23;border-radius:6px;overflow:hidden}
  .thumb img{display:block;width:100%;height:auto;min-height:80px}
  .thumb .label{padding:4px 6px;font-size:10px;font-family:monospace;color:#9ca3af;border-top:1px solid #1f1f23;word-break:break-all}
  .empty{opacity:.4;font-size:12px;font-style:italic;padding:20px;text-align:center}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;margin-left:6px}
  .badge.on{background:#166534;color:#86efac}
  .badge.off{background:#374151;color:#9ca3af}
</style></head>
<body><div class="wrap">
<h1>CapCut Login Dashboard</h1>
<div class="sub">Auto-refresh every 3s · Port ${HTTP_PORT} · Uptime ${uptimeS}s · <a href="/debug-bundle" style="color:#93c5fd" target="_blank">Download Debug Bundle (.json)</a></div>

<div class="phase ${status.currentPhase}">${phaseLabel}${status.lastError ? `<br><span style="font-size:12px;color:#fca5a5">Error: ${escapeHtml(status.lastError)}</span>` : ''}</div>

<div class="grid">
  <div class="card">
    <h2>QR Code (scan this with CapCut mobile app)</h2>
    <div class="qr-wrap">
      <img src="/qr?t=${Date.now()}" alt="QR code">
    </div>
    <div style="margin-top:8px;font-size:11px;opacity:.6;text-align:center">
      Buka CapCut di HP → Profile (tab kanan) → icon Scan di kanan atas
    </div>
  </div>

  <div class="card">
    <h2>Status</h2>
    <div class="kv"><span class="k">Phase</span><span class="v">${status.currentPhase}</span></div>
    <div class="kv"><span class="k">Browser launched</span><span class="v">${status.browserLaunched ? '✓' : '✗'}</span></div>
    <div class="kv"><span class="k">Login page loaded</span><span class="v">${status.loginPageLoaded ? '✓' : '✗'}</span></div>
    <div class="kv"><span class="k">Mobile button found</span><span class="v">${status.mobileButtonFound ? '✓' : '✗'}</span></div>
    <div class="kv"><span class="k">Button clicked</span><span class="v">${status.mobileButtonClicked ? '✓' : '✗'}</span></div>
    <div class="kv"><span class="k">Popup opened</span><span class="v">${status.popupOpened ? '✓' : '✗'}</span></div>
    <div class="kv"><span class="k">QR detected</span><span class="v">${status.qrDetected ? '✓' : '✗'}</span></div>
    <div class="kv"><span class="k">Login detected</span><span class="v">${status.loginDetected ? '✓' : '✗'}</span></div>
    <div class="kv"><span class="k">Page count</span><span class="v">${status.pageCount}</span></div>
    <div class="kv"><span class="k">Frame count</span><span class="v">${status.frameCount}</span></div>
    <div class="kv"><span class="k">Iframe count</span><span class="v">${status.iframeCount}</span></div>
    <div class="kv"><span class="k">Canvas count</span><span class="v">${status.canvasCount}</span></div>
    <div class="kv"><span class="k">Dialog count</span><span class="v">${status.dialogCount}</span></div>
    <div class="kv"><span class="k">Cookies</span><span class="v">${status.cookieCount}</span></div>
    <div class="kv"><span class="k">Session cookie</span><span class="v">${status.hasSessionCookie ? '✓' : '✗'}</span></div>
    <div class="kv"><span class="k">Current URL</span><span class="v" style="font-size:10px;text-align:right;max-width:60%;word-break:break-all">${escapeHtml(status.currentUrl || '-')}</span></div>
    ${status.popupUrl ? `<div class="kv"><span class="k">Popup URL</span><span class="v" style="font-size:10px;text-align:right;max-width:60%;word-break:break-all">${escapeHtml(status.popupUrl)}</span></div>` : ''}
    ${status.lastError ? `<div class="kv"><span class="k">Last error</span><span class="v" style="color:#f87171;font-size:10px">${escapeHtml(status.lastError)}</span></div>` : ''}
  </div>
</div>

<div class="card" style="margin-bottom:20px">
  <h2>Screenshots gallery (all pages + iframes)</h2>
  ${status.screenshots.length === 0 ? '<div class="empty">No screenshots yet — browser is still launching or page is still loading.</div>' : `
  <div class="gallery">
    ${status.screenshots.slice(-12).reverse().map(s => `
      <div class="thumb">
        <img src="/shot?name=${encodeURIComponent(s.name)}" alt="${s.name}">
        <div class="label">${s.name}<br>${Math.round(s.size / 1024)}KB · ${s.kind}</div>
      </div>
    `).join('')}
  </div>`}
</div>

<div class="card">
  <h2>Recent logs</h2>
  <div class="logs">
    ${status.recentLogs.length === 0 ? '<div class="empty">No logs yet.</div>' :
      status.recentLogs.slice().reverse().map(l => `
        <div class="log-line ${l.level}"><span class="log-ts">${l.ts.slice(11, 19)}</span>[${l.level}] ${escapeHtml(l.msg)}${l.extra ? ' ' + escapeHtml(l.extra) : ''}</div>
      `).join('')}
  </div>
</div>

</div></body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ====== Helper: scan file size, simpan ke status.screenshots ======
function trackScreenshot(name, kind = 'unknown') {
  const p = path.join(tmpDir, name);
  if (!fs.existsSync(p)) return null;
  const stat = fs.statSync(p);
  const entry = { name, path: p, mtime: stat.mtimeMs, size: stat.size, kind };
  // Replace if same name already tracked
  const idx = status.screenshots.findIndex(s => s.name === name);
  if (idx >= 0) status.screenshots[idx] = entry;
  else status.screenshots.push(entry);
  return entry;
}

// ====== Launch browser ======
// Note: main flow is wrapped in a labeled block so we can `break mainFlow;`
// to skip the rest if browser launch or page open fails — but keep the HTTP
// server alive so user can see the error in the dashboard.
setStatus('launching-browser');
logger.info('Launching Chromium…');
let browser = null;

// CRITICAL HELPER: page.screenshot() can hang FOREVER on some Linux servers
// when the page has heavy canvas/animation/GPU activity (CapCut login page has
// splash animations). When it hangs, .catch() doesn't help because the promise
// never resolves OR rejects — it just sits there. This wraps every screenshot
// call in a 5s timeout via Promise.race. If timeout, we log + move on so the
// script keeps progressing (button search, polling, etc.).
async function screenshotWithTimeout(target, opts = {}, ms = 5000) {
  try {
    const result = await Promise.race([
      target.screenshot(opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`screenshot timeout after ${ms}ms`)), ms)),
    ]);
    return result;
  } catch (e) {
    // Don't throw — caller already wrote .catch(()=>{}) everywhere, but to be safe
    logger.warn({ err: e.message, opts: Object.keys(opts).join(',') }, 'Screenshot failed or timed out, skipping');
    return null;
  }
}

mainFlow: {
try {
  browser = await puppeteer.launch({
    headless: !hasDisplay,
    userDataDir,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--window-size=1440,900',
      '--lang=en-US,en',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    env: {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '/dev/null',
    },
  });
  status.browserLaunched = true;
  logger.info('Chromium launched successfully');
} catch (e) {
  status.lastError = e.message;
  logger.error({ err: e.message }, 'Failed to launch Chromium');
  setStatus('error', { lastError: e.message });
  persistStatus();
  // Keep HTTP server alive supaya user bisa lihat error di dashboard
  // process.exit(1) — JANGAN, biar user bisa lihat dashboard
  // Start a heartbeat to keep status fresh
  setInterval(persistStatus, 2000);
  break mainFlow;
}

const pages = await browser.pages();
const page = pages[0] || await browser.newPage();

// Track new tabs/popups
let popupPage = null;
browser.on('targetcreated', async (target) => {
  const type = target.type();
  const url = target.url();
  logger.info({ type, url: url.slice(0, 100) }, 'New browser target created');
  if (type === 'page' && !popupPage) {
    try {
      popupPage = await target.page();
      if (popupPage) {
        status.popupOpened = true;
        status.popupUrl = popupPage.url();
        logger.info({ url }, 'Popup/new tab detected, tracking it for QR code');
      }
    } catch (_) {}
  }
});

await page.setUserAgent(
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
);

await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5].map(() => ({})) });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
  window.chrome = window.chrome || { runtime: {} };
});

// ====== Buka halaman login CapCut ======
setStatus('loading-page');
logger.info('Opening CapCut login page...');

const loginUrls = [
  'https://www.capcut.com/login?enter_from=https%3A%2F%2Fwww.capcut.com%2Ftemplates',
  'https://www.capcut.com/login',
  'https://www.capcut.com/zh-tw/login',
];

let pageOpened = false;
for (const url of loginUrls) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 3000));
    logger.info({ url: page.url() }, 'Page loaded');
    status.loginPageLoaded = true;
    status.currentUrl = page.url();
    pageOpened = true;
    // Take immediate screenshot supaya dashboard langsung ada gambar
    // CRITICAL: wrapped with 5s timeout — on some Linux servers this can hang forever
    await screenshotWithTimeout(page, { path: mainPageShotPath, fullPage: false });
    trackScreenshot('main-page.png', 'main');
    break;
  } catch (e) {
    logger.warn({ url, err: e.message }, 'Failed to open login URL');
    status.lastError = e.message;
  }
}

if (!pageOpened) {
  logger.error('Could not open CapCut login page. Check internet connection.');
  setStatus('error', { lastError: 'Could not open CapCut login page' });
  persistStatus();
  setInterval(persistStatus, 2000);
  break mainFlow;
}

// ====== Step 1: Click "Continue with CapCut Mobile" to reveal QR code ======
setStatus('finding-button');
logger.info('Looking for "Continue with CapCut Mobile" button...');

const MOBILE_BTN_TEXTS = [
  'Continue with CapCut Mobile',
  'CapCut Mobile',
  'Sign in with CapCut Mobile',
  'Login with CapCut Mobile',
  '扫码登录',
  '掃碼登入',
  'Scan to login',
  'Scan QR',
  'QR Code Login',
];

async function findMobileLoginButton(targetPage) {
  const result = await targetPage.evaluate((texts) => {
    const lowerTexts = texts.map((t) => t.toLowerCase());
    const clickableSelectors = 'button, a, div[role="button"], span[role="button"], [class*="btn" i], [class*="button" i]';
    const candidates = Array.from(document.querySelectorAll(clickableSelectors));
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (!text || text.length > 100) continue;
      const matches = lowerTexts.some((t) => text === t || text.includes(t));
      if (!matches) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 20) continue;
      if (rect.top < 0 || rect.left < 0) continue;
      if (text.includes('google') || text.includes('email') || text.includes('tiktok') || text.includes('facebook')) continue;
      el.setAttribute('data-capcut-mobile-btn', 'true');
      return { found: true, text: text.slice(0, 80), tag: el.tagName.toLowerCase(), width: rect.width, height: rect.height, top: rect.top, left: rect.left };
    }
    return { found: false };
  }, MOBILE_BTN_TEXTS);
  return result;
}

let mobileBtnClicked = false;
for (let attempt = 0; attempt < 8 && !mobileBtnClicked; attempt++) {
  try {
    const mobileBtnInfo = await findMobileLoginButton(page);
    if (mobileBtnInfo.found) {
      status.mobileButtonFound = true;
      setStatus('clicking');
      logger.info({ attempt, ...mobileBtnInfo }, 'Found CapCut Mobile button, clicking...');

      const centerX = mobileBtnInfo.left + mobileBtnInfo.width / 2;
      const centerY = mobileBtnInfo.top + mobileBtnInfo.height / 2;

      try {
        await page.mouse.move(centerX, centerY, { steps: 5 });
        await new Promise((r) => setTimeout(r, 200));
        await page.mouse.click(centerX, centerY, { delay: 50 });
        mobileBtnClicked = true;
        status.mobileButtonClicked = true;
        status.lastButtonClick = { x: centerX, y: centerY, text: mobileBtnInfo.text };
        logger.info({ x: centerX, y: centerY }, 'Real mouse click sent to button center');
      } catch (e) {
        logger.warn({ err: e.message }, 'Mouse click failed, trying element.click() fallback');
        try {
          const handle = await page.$('[data-capcut-mobile-btn="true"]');
          if (handle) {
            await handle.click();
            mobileBtnClicked = true;
            status.mobileButtonClicked = true;
            logger.info('ElementHandle.click() fallback succeeded');
          }
        } catch (e2) {
          logger.warn({ err: e2.message }, 'ElementHandle.click() also failed');
          status.lastError = e2.message;
        }
      }

      await page.evaluate(() => {
        const btn = document.querySelector('[data-capcut-mobile-btn="true"]');
        if (btn) btn.removeAttribute('data-capcut-mobile-btn');
      }).catch(() => {});

      if (mobileBtnClicked) break;
    }
  } catch (e) {
    logger.warn({ err: e.message, attempt }, 'Error finding mobile button');
    status.lastError = e.message;
  }
  if (!mobileBtnClicked) {
    if (attempt === 0) logger.warn('CapCut Mobile button not found yet, retrying...');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (!mobileBtnClicked) {
  logger.warn('Could not find "Continue with CapCut Mobile" button after 8 attempts.');
  logger.info('Continuing anyway — will try to detect QR if it auto-appears...');
} else {
  setStatus('waiting-qr');
  logger.info('Waiting for QR code modal to render...');
  await new Promise((r) => setTimeout(r, 3000));
}

// Take immediate post-click screenshot
await screenshotWithTimeout(page, { path: path.join(tmpDir, 'after-click.png'), fullPage: false });
trackScreenshot('after-click.png', 'post-click');

// ====== Polling: detect login + capture QR from ALL pages/frames ======
const startTime = Date.now();
let lastScreenshotTime = 0;
let qrFound = false;
let tries = 0;

async function captureAllScreenshots() {
  const allPages = await browser.pages().catch(() => []);
  status.pageCount = allPages.length;

  // 1. Screenshot main page (5s timeout — never hang on slow servers)
  await screenshotWithTimeout(page, { path: mainPageShotPath, fullPage: false });
  trackScreenshot('main-page.png', 'main');

  // 2. Screenshot popup page if exists
  if (popupPage && !popupPage.isClosed()) {
    const popupShotPath = path.join(tmpDir, 'popup.png');
    await screenshotWithTimeout(popupPage, { path: popupShotPath, fullPage: false });
    trackScreenshot('popup.png', 'popup');
    status.popupUrl = popupPage.url();
  }

  // 3. Screenshot each same-origin iframe content (kalau accessible)
  try {
    const frames = page.frames();
    status.frameCount = frames.length;
    let iframeIdx = 0;
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue; // skip main, already shot
      iframeIdx++;
      try {
        const frameUrl = frame.url();
        if (!frameUrl || frameUrl === 'about:blank') continue;
        const frameShotPath = path.join(tmpDir, `frame-${iframeIdx}.png`);
        const frameInfo = await page.evaluate((idx) => {
          const iframes = Array.from(document.querySelectorAll('iframe'));
          const f = iframes[idx - 1];
          if (!f) return null;
          const r = f.getBoundingClientRect();
          return { top: r.top, left: r.left, width: r.width, height: r.height };
        }, iframeIdx).catch(() => null);

        if (frameInfo && frameInfo.width > 50 && frameInfo.height > 50) {
          await screenshotWithTimeout(page, {
            path: frameShotPath,
            clip: {
              x: Math.max(0, frameInfo.left),
              y: Math.max(0, frameInfo.top),
              width: Math.min(1440, frameInfo.width),
              height: Math.min(900, frameInfo.height),
            },
          });
          trackScreenshot(`frame-${iframeIdx}.png`, 'iframe');
        }
      } catch (_) {}
    }
  } catch (_) {}

  // 4. Update diagnostic counts
  try {
    const diag = await page.evaluate(() => ({
      canvases: document.querySelectorAll('canvas').length,
      iframes: document.querySelectorAll('iframe').length,
      dialogs: document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="popup" i], [class*="dialog" i]').length,
      overlays: Array.from(document.querySelectorAll('div')).filter((d) => {
        const s = getComputedStyle(d);
        const r = d.getBoundingClientRect();
        return (s.position === 'fixed' || s.position === 'absolute') && r.width > 200 && r.height > 200 && s.zIndex !== 'auto' && parseInt(s.zIndex || '0', 10) > 100;
      }).length,
    })).catch(() => ({}));
    status.iframeCount = diag.iframes || 0;
    status.canvasCount = diag.canvases || 0;
    status.dialogCount = diag.dialogs || 0;
  } catch (_) {}
}

// Find QR code element AND extract its pixels via canvas.toDataURL() or img.src.
// CRITICAL: validates that canvas has non-uniform pixel content (i.e. the QR
// has actually been drawn, not just the empty canvas element).
async function findQrCanvasOrImg(targetPage) {
  return await targetPage.evaluate(() => {
    function isCanvasNonUniform(canvas) {
      // Returns true if canvas has actual varying pixel content (not blank).
      // CapCut's QR canvas is sometimes created empty and drawn into ~200-500ms later.
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        const w = canvas.width;
        const h = canvas.height;
        if (w < 50 || h < 50) return false;
        const data = ctx.getImageData(0, 0, w, h).data;
        if (!data || data.length < 16) return false;
        // Sample at most 400 pixels (every Nth pixel) for speed
        const stride = Math.max(4, Math.floor(data.length / 4 / 400)) * 4;
        let blackCount = 0, whiteCount = 0, sampleCount = 0;
        for (let i = 0; i < data.length; i += stride) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const lum = (r + g + b) / 3;
          if (lum < 80) blackCount++;
          else if (lum > 180) whiteCount++;
          sampleCount++;
        }
        if (sampleCount === 0) return false;
        // Real QR: at least 10% black AND 10% white. Blank canvas would be ~100% one color.
        const blackRatio = blackCount / sampleCount;
        const whiteRatio = whiteCount / sampleCount;
        return blackRatio > 0.1 && whiteRatio > 0.1;
      } catch (_) {
        return false; // canvas not readable (CORS, tainted) — treat as no QR
      }
    }

    function extractCanvasDataUrl(canvas) {
      try { return canvas.toDataURL('image/png'); } catch (_) { return null; }
    }

    // Strategy 1: canvas with reasonable QR dimensions + non-uniform content
    const canvases = Array.from(document.querySelectorAll('canvas'));
    for (const c of canvases) {
      const rect = c.getBoundingClientRect();
      if (Math.abs(rect.width - rect.height) < 20 && rect.width >= 100 && rect.width <= 500) {
        const parent = c.parentElement;
        const parentClass = parent ? parent.className.toLowerCase() : '';
        if (parentClass.includes('logo') || parentClass.includes('icon')) continue;

        // VALIDATE: canvas must have actual QR pixels drawn, not be blank
        if (!isCanvasNonUniform(c)) {
          // Canvas exists but blank — QR not yet rendered. Keep looking/waiting.
          return { found: false, blankCanvas: true, w: rect.width, h: rect.height };
        }

        const dataUrl = extractCanvasDataUrl(c);
        return {
          found: true,
          type: 'canvas',
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          dataUrl,
        };
      }
    }

    // Strategy 2: img with qr-ish src/alt OR img with data:image/png src (QR as base64)
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const i of imgs) {
      const src = (i.src || '');
      const alt = (i.alt || '').toLowerCase();
      const rect = i.getBoundingClientRect();
      if (rect.width < 80) continue;
      const srcLow = src.toLowerCase();
      if (srcLow.includes('qr') || alt.includes('qr') ||
          (src.startsWith('data:image/png;base64,') && rect.width >= 100 && Math.abs(rect.width - rect.height) < 30)) {
        return {
          found: true,
          type: 'img',
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          dataUrl: src.startsWith('data:') ? src : null,
        };
      }
    }

    // Strategy 3: svg with class containing qr
    const svgs = Array.from(document.querySelectorAll('svg'));
    for (const s of svgs) {
      const cls = (s.className?.baseVal || s.getAttribute('class') || '').toLowerCase();
      const rect = s.getBoundingClientRect();
      if (cls.includes('qr') && rect.width >= 100) {
        return { found: true, type: 'svg', width: rect.width, height: rect.height, top: rect.top, left: rect.left, dataUrl: null };
      }
    }

    // Strategy 4: any element with qr in class name
    const qrEls = Array.from(document.querySelectorAll('[class*="qr" i], [class*="qrcode" i], [class*="scan" i]'));
    for (const el of qrEls) {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || '').toLowerCase();
      if (text.includes('continue with')) continue;
      if (rect.width < 100 || rect.height < 100) continue;
      return { found: true, type: 'element', width: rect.width, height: rect.height, top: rect.top, left: rect.left, dataUrl: null };
    }

    return { found: false };
  }).catch(() => ({ found: false }));
}

// Pick "best" QR-like screenshot from all tracked screenshots.
// Heuristic: prefer canvas/svg/qr-element > popup > main > iframe
function pickBestQrScreenshot() {
  const order = ['canvas', 'svg', 'element', 'img', 'popup', 'main', 'iframe', 'post-click', 'unknown'];
  const sorted = [...status.screenshots].sort((a, b) => {
    const ai = order.indexOf(a.kind);
    const bi = order.indexOf(b.kind);
    if (ai !== bi) return ai - bi;
    return b.size - a.size; // larger first within same kind
  });
  return sorted[0] || null;
}

async function checkLogin() {
  tries++;
  const elapsedMs = Date.now() - startTime;

  if (elapsedMs > MAX_WAIT_MS) {
    logger.warn({ elapsedMs }, `Timeout ${MAX_WAIT_MS / 1000}s. No login detected.`);
    setStatus('timeout');
    persistStatus();
    return 'timeout';
  }

  try {
    const activePage = popupPage && !popupPage.isClosed() ? popupPage : page;
    status.currentUrl = activePage.url();

    // Detect login via cookies + URL change
    const cookies = await page.cookies();
    status.cookieCount = cookies.length;
    const sessionCookie = cookies.find((c) =>
      /session|token|uid|passport|login|sid|tt_csrf|s_v_web_id/i.test(c.name) && c.value && c.value.length > 10
    );
    status.hasSessionCookie = !!sessionCookie;

    const stillOnLogin = /\/login|\/scan-qr-code/i.test(status.currentUrl);

    let avatarFound = false;
    if (!stillOnLogin) {
      try {
        avatarFound = await page.$(
          '[class*="avatar" i], [data-e2e*="user" i], [data-testid*="user" i], [class*="user-info" i], [class*="header-user" i], [class*="account" i]'
        ) ? true : false;
      } catch (_) {}
    }

    if (sessionCookie && (!stillOnLogin || avatarFound)) {
      logger.info({ url: status.currentUrl, cookie: sessionCookie?.name, avatarFound }, 'LOGIN SUCCESS detected!');
      status.loginDetected = true;
      setStatus('success');
      persistStatus();
      return 'success';
    }

    // Capture screenshots from ALL pages + frames
    const now = Date.now();
    if (now - lastScreenshotTime > 1500) {
      await captureAllScreenshots();

      // Detect QR: scan main page, popup page, AND all frames
      let qrInfo = null;
      let qrSource = null;

      // Check main page first
      const mainQr = await findQrCanvasOrImg(page);
      if (mainQr?.found) { qrInfo = mainQr; qrSource = 'main'; }

      // Check popup page
      if (!qrInfo && popupPage && !popupPage.isClosed()) {
        const popupQr = await findQrCanvasOrImg(popupPage);
        if (popupQr?.found) { qrInfo = popupQr; qrSource = 'popup'; }
      }

      // Check each iframe
      if (!qrInfo) {
        try {
          const frames = page.frames();
          for (let i = 0; i < frames.length; i++) {
            if (frames[i] === page.mainFrame()) continue;
            try {
              const frameQr = await findQrCanvasOrImg(frames[i]);
              if (frameQr?.found) {
                qrInfo = frameQr;
                qrSource = `frame-${i}`;
                break;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      // Update phase + QR marker
      if (qrInfo?.found && !qrFound) {
        qrFound = true;
        status.qrDetected = true;
        setStatus('waiting-login');
        logger.info({ type: qrInfo.type, source: qrSource, w: Math.round(qrInfo.width), h: Math.round(qrInfo.height), hasDataUrl: !!qrInfo.dataUrl }, 'QR code element detected!');
      } else if (qrFound && status.currentPhase === 'waiting-qr') {
        setStatus('waiting-login');
      }

      // Save best screenshot as qr-latest.png
      // PRIORITY 1: if QR element has dataUrl (canvas.toDataURL or img src), write that directly.
      //   This gets EXACT pixels — no clipping artifacts, no timing issues.
      // PRIORITY 2: if no dataUrl, clip-screenshot the QR element region.
      // PRIORITY 3: fallback to best screenshot from gallery.
      let qrSavedThisRound = false;
      if (qrInfo?.found) {
        // PRIORITY 1: dataUrl
        if (qrInfo.dataUrl && qrInfo.dataUrl.startsWith('data:image/png;base64,')) {
          try {
            const buf = Buffer.from(qrInfo.dataUrl.split(',')[1], 'base64');
            fs.writeFileSync(qrLatestPath, buf);
            qrSavedThisRound = true;
            if (tries % 8 === 0) {
              logger.info({ size: buf.length, source: qrSource }, 'QR pixels saved via canvas.toDataURL()');
            }
          } catch (e) {
            logger.warn({ err: e.message }, 'Failed to write QR from dataUrl, falling back to screenshot');
          }
        }

        // PRIORITY 2: clip screenshot
        if (!qrSavedThisRound) {
          const targetPage = qrSource === 'popup' && popupPage && !popupPage.isClosed() ? popupPage : page;
          // PRIORITY 2: clip screenshot (with 5s timeout — never hang)
          const clipBuf = await screenshotWithTimeout(targetPage, {
            path: qrLatestPath,
            clip: {
              x: Math.max(0, qrInfo.left - 40),
              y: Math.max(0, qrInfo.top - 40),
              width: qrInfo.width + 80,
              height: qrInfo.height + 80,
            },
          });
          if (clipBuf !== null) {
            qrSavedThisRound = true;
          } else {
            // fallback: full screenshot
            const fullBuf = await screenshotWithTimeout(targetPage, { path: qrLatestPath, fullPage: false });
            if (fullBuf !== null) qrSavedThisRound = true;
          }
        }
      } else if (qrInfo?.blankCanvas) {
        // Canvas exists but blank — QR not yet rendered. Don't overwrite qr-latest.png
        // with a blank canvas. Keep previous content (or fall back to popup screenshot).
        if (!fs.existsSync(qrLatestPath) || fs.statSync(qrLatestPath).size < 1500) {
          // No QR saved yet, fall through to popup screenshot
        } else {
          qrSavedThisRound = true; // keep existing QR
        }
      }

      if (!qrSavedThisRound) {
        // PRIORITY 3: pick best screenshot from gallery (prefer popup > main)
        const best = pickBestQrScreenshot();
        if (best && best.path !== qrLatestPath) {
          try {
            fs.copyFileSync(best.path, qrLatestPath);
          } catch (_) {}
        }
      }

      lastScreenshotTime = now;

      // Periodic full debug screenshot
      if (tries % 5 === 0) {
        const debugPath = path.join(screenshotDir, `debug-${tries}.png`);
        await screenshotWithTimeout(activePage, { path: debugPath, fullPage: false });
      }
    }

    if (tries % 6 === 0) {
      logger.info(
        { tries, elapsedS: Math.round(elapsedMs / 1000), url: status.currentUrl, qrFound, hasSessionCookie: !!sessionCookie, popupAlive: popupPage && !popupPage.isClosed(), pages: status.pageCount, frames: status.frameCount },
        'Waiting for login...'
      );
    }

    persistStatus();
  } catch (e) {
    logger.warn({ err: e.message }, 'Polling error');
    status.lastError = e.message;
  }

  return 'continue';
}

const pollLoop = async () => {
  while (true) {
    const result = await checkLogin();
    if (result === 'success') {
      await new Promise((r) => setTimeout(r, 2000));
      try { await browser.close(); } catch (_) {}
      logger.info(`✓ Session saved to ${userDataDir}`);
      logger.info('Set CAPCUT_USER_DATA_DIR=./.capcut-profile di .env untuk reuse session ini.');
      // Keep HTTP server alive for 10 more seconds supaya user bisa lihat success message
      setTimeout(() => { httpServer.close(); process.exit(0); }, 10000);
      return;
    }
    if (result === 'timeout') {
      try { await browser.close(); } catch (_) {}
      setTimeout(() => { httpServer.close(); process.exit(1); }, 10000);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
};

pollLoop().catch((e) => {
  logger.error({ err: e.message }, 'Fatal error in poll loop');
  status.lastError = e.message;
  setStatus('error');
  persistStatus();
  try { browser?.close(); } catch (_) {}
  // Keep HTTP server alive
  setInterval(persistStatus, 2000);
});

} // end mainFlow

// Graceful shutdown
const shutdown = async (sig) => {
  logger.info({ sig }, 'Received signal, closing browser...');
  if (browser) { try { await browser.close(); } catch (_) {} }
  httpServer.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
