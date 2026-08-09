// scripts/manual-login.js
// CapCut manual login — works on HEADLESS servers (no X server / no display).
//
// Strategi:
// 1. Launch Chromium dalam headless mode (modern headless, bukan old headless).
// 2. Buka https://www.capcut.com/login — CapCut akan tampilkan QR code.
// 3. Screenshot QR code berkala ke tmp/qr-latest.png.
// 4. Jalankan HTTP server kecil di port 3001 (CAPCUT_LOGIN_PORT) untuk serve screenshot.
// 5. User buka SSH tunnel: ssh -L 3001:localhost:3001 root@<server> -p <port>
//    lalu buka http://localhost:3001/ di browser lokal → scan QR pake HP.
// 6. Script poll untuk detect login (cookies, URL change, avatar element).
// 7. Setelah login terdeteksi → session disimpan ke .capcut-profile/ (userDataDir).
//
// Cara pakai di server headless:
//   npm run login:manual
//   # di terminal lokal (laptop): ssh -L 3001:localhost:3001 root@sakura.proxy.rlwy.net -p 39551
//   # buka http://localhost:3001/ di browser lokal → scan QR pake CapCut HP
//
// Cara pakai di local dengan display (desktop):
//   DISPLAY=:0 npm run login:manual   # otomatis pakai headless:false

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
fs.mkdirSync(screenshotDir, { recursive: true });
fs.rmSync(qrLatestPath, { force: true });

// ====== Konfigurasi ======
const HTTP_PORT = parseInt(process.env.CAPCUT_LOGIN_PORT || '3001', 10);
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 6 * 60 * 1000; // 6 menit
const hasDisplay = !!process.env.DISPLAY && process.env.DISPLAY.length > 0;

logger.info({
  userDataDir,
  hasDisplay,
  headless: !hasDisplay,
  httpPort: HTTP_PORT,
}, 'Manual login mode (headless Chromium + HTTP QR viewer)');

// ====== HTTP server untuk serve QR screenshot ======
const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>CapCut Login QR</title>
<meta http-equiv="refresh" content="2">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{background:#0f0f10;color:#eee;font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:30px 20px;margin:0;min-height:100vh}
  h1{font-size:20px;margin:0 0 8px;color:#fff}
  .sub{opacity:.6;font-size:13px;margin-bottom:24px}
  .qr-wrap{background:#fff;padding:16px;border-radius:12px;display:inline-block;box-shadow:0 8px 32px rgba(0,0,0,.4)}
  .qr-wrap img{display:block;max-width:380px;width:100%;height:auto;image-rendering:pixelated}
  .meta{margin-top:20px;font-size:12px;opacity:.5;font-family:monospace}
  .status{margin-top:16px;padding:8px 16px;border-radius:8px;background:#1f1f23;display:inline-block;font-size:13px}
  .ok{background:#1a3a1a;color:#7fff7f}
</style></head>
<body>
<h1>CapCut Login QR Code</h1>
<div class="sub">Auto-refresh setiap 2 detik. Scan pake aplikasi CapCut di HP.</div>
<div class="qr-wrap">
  <img src="/qr?t=${Date.now()}" alt="QR code screenshot" onerror="this.style.display='none'">
</div>
<div class="status" id="s">⏳ Waiting for QR code…</div>
<div class="meta">Page auto-refresh every 2s · Port ${HTTP_PORT}</div>
</body></html>`);
    return;
  }

  if (url === '/qr') {
    if (!fs.existsSync(qrLatestPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('QR not ready yet');
      return;
    }
    const stat = fs.statSync(qrLatestPath);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    fs.createReadStream(qrLatestPath).pipe(res);
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: HTTP_PORT, qrReady: fs.existsSync(qrLatestPath) }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found. Try / or /qr');
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  logger.info(`HTTP QR viewer listening on http://0.0.0.0:${HTTP_PORT}/`);
  logger.info('──── INSTRUKSI LOGIN ────');
  logger.info(`1. Di terminal lokal (laptop), buka SSH tunnel:`);
  logger.info(`     ssh -L ${HTTP_PORT}:localhost:${HTTP_PORT} root@sakura.proxy.rlwy.net -p 39551`);
  logger.info(`2. Di browser lokal, buka: http://localhost:${HTTP_PORT}/`);
  logger.info(`3. Scan QR code yang muncul pake aplikasi CapCut di HP`);
  logger.info(`4. Script akan auto-detect login & save session`);
  logger.info('─────────────────────────');
});

httpServer.on('error', (e) => {
  logger.error({ err: e.message }, 'HTTP server error');
  if (e.code === 'EADDRINUSE') {
    logger.error(`Port ${HTTP_PORT} sudah dipakai. Set CAPCUT_LOGIN_PORT=3002 untuk pake port lain.`);
  }
  process.exit(1);
});

// ====== Launch browser ======
const browser = await puppeteer.launch({
  headless: !hasDisplay, // true kalau no DISPLAY (server), false kalau ada (desktop)
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
  // ignoreDefaultArgs: ['--enable-automation'],
});

const pages = await browser.pages();
const page = pages[0] || await browser.newPage();

await page.setUserAgent(
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
);

// Anti-detection: hide webdriver flag, spoof plugins/languages
await page.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map(() => ({})),
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
  window.chrome = window.chrome || { runtime: {} };
});

// ====== Buka halaman login CapCut ======
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
    pageOpened = true;
    break;
  } catch (e) {
    logger.warn({ url, err: e.message }, 'Failed to open login URL');
  }
}

if (!pageOpened) {
  logger.error('Tidak bisa buka halaman login CapCut. Cek koneksi internet.');
  await browser.close();
  httpServer.close();
  process.exit(1);
}

// ====== Polling: detect login + capture QR ======
const startTime = Date.now();
let lastScreenshotTime = 0;
let qrFound = false;
let tries = 0;

async function checkLogin() {
  tries++;
  const elapsedMs = Date.now() - startTime;

  if (elapsedMs > MAX_WAIT_MS) {
    logger.warn({ elapsedMs }, `Timeout ${MAX_WAIT_MS / 1000}s. No login detected.`);
    return 'timeout';
  }

  try {
    const currentUrl = page.url();

    // Cek 1: URL tidak lagi /login (redirect ke home/dashboard)
    const stillOnLogin = /\/login/i.test(currentUrl);

    // Cek 2: cookies session
    const cookies = await page.cookies();
    const sessionCookie = cookies.find(
      (c) =>
        /session|token|uid|passport|login/i.test(c.name) && c.value && c.value.length > 10
    );

    // Cek 3: avatar / user element di header
    let avatarFound = false;
    if (!stillOnLogin) {
      try {
        avatarFound = await page.$(
          '[class*="avatar" i], [data-e2e*="user" i], [data-testid*="user" i], [class*="user-info" i], [class*="header-user" i], [class*="account" i]'
        ) ? true : false;
      } catch (_) {}
    }

    if (sessionCookie && (!stillOnLogin || avatarFound)) {
      logger.info({ url: currentUrl, cookie: sessionCookie.name, avatarFound }, 'LOGIN SUCCESS detected!');
      return 'success';
    }

    // Screenshot QR code (atau full page jika QR tidak kedetect)
    const now = Date.now();
    if (now - lastScreenshotTime > 1500) {
      try {
        // Cari elemen QR code
        const qrEl = await page.$(
          'canvas, [class*="qr" i], img[alt*="qr" i], [class*="qrcode" i], [class*="qr-code" i], [class*="QRCode" i]'
        );

        let shotPath;
        if (qrEl) {
          if (!qrFound) {
            logger.info('QR code element detected, capturing...');
            qrFound = true;
          }
          shotPath = qrLatestPath;
          await qrEl.screenshot({ path: shotPath }).catch(async () => {
            // Fallback: full page screenshot
            await page.screenshot({ path: shotPath, fullPage: false });
          });
        } else {
          // Fallback: full page screenshot (mungkin QR belum render atau perlu klik tab)
          shotPath = qrLatestPath;
          await page.screenshot({ path: shotPath, fullPage: false });

          // Coba klik tab "QR" kalau ada (sekali saja)
          if (tries === 2) {
            try {
              const qrTab = await page.$(
                'button:has-text("QR"), a:has-text("QR"), [class*="qr-tab" i], div:has-text("Scan QR"), [class*="qr-login" i]'
              );
              if (qrTab) {
                logger.info('Found QR login tab, clicking...');
                await qrTab.click();
                await new Promise((r) => setTimeout(r, 2000));
              }
            } catch (_) {}
          }
        }
        lastScreenshotTime = now;

        // Save periodic debug screenshot
        if (tries % 5 === 0) {
          const debugPath = path.join(screenshotDir, `debug-${tries}.png`);
          await page.screenshot({ path: debugPath, fullPage: false });
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'Screenshot error');
      }
    }

    if (tries % 6 === 0) {
      logger.info(
        { tries, elapsedS: Math.round(elapsedMs / 1000), url: currentUrl, qrFound, hasSessionCookie: !!sessionCookie },
        'Waiting for login...'
      );
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Polling error');
  }

  return 'continue';
}

const pollLoop = async () => {
  while (true) {
    const result = await checkLogin();
    if (result === 'success') {
      // Beri delay sedikit untuk pastikan session tersimpan
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await browser.close();
      } catch (_) {}
      httpServer.close();
      logger.info(`✓ Session saved to ${userDataDir}`);
      logger.info('Set CAPCUT_USER_DATA_DIR=./.capcut-profile di .env untuk reuse session ini.');
      process.exit(0);
    }
    if (result === 'timeout') {
      try {
        await browser.close();
      } catch (_) {}
      httpServer.close();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
};

pollLoop().catch((e) => {
  logger.error({ err: e.message }, 'Fatal error in poll loop');
  try { browser.close(); } catch (_) {}
  httpServer.close();
  process.exit(1);
});

// Graceful shutdown
const shutdown = async (sig) => {
  logger.info({ sig }, 'Received signal, closing browser...');
  try { await browser.close(); } catch (_) {}
  httpServer.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
