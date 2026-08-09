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

// Clean up stale SingletonLock from previous crashed chrome instance
// (Without this, chromium refuses to launch: "Failed to create SingletonLock: File exists")
for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  const lockPath = path.join(userDataDir, lockFile);
  try {
    fs.rmSync(lockPath, { force: true });
  } catch (_) {}
}

// ====== Konfigurasi ======
// Port untuk HTTP QR viewer. Kalau 3001 sibuk, otomatis cari port kosong
// di rentang 3002..3010 (cleared up to 9 retries). Override via env var
// kalau mau pakai port spesifik tanpa fallback.
const PREFERRED_PORT = parseInt(process.env.CAPCUT_LOGIN_PORT || '3001', 10);
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 6 * 60 * 1000; // 6 menit
const hasDisplay = !!process.env.DISPLAY && process.env.DISPLAY.length > 0;

// Helper: cek apakah port kosong
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '0.0.0.0');
  });
}

// Helper: cari port kosong mulai dari preferred, naik 1 per 1 sampai preferred+9
async function findFreePort(preferred) {
  for (let p = preferred; p <= preferred + 9; p++) {
    if (await isPortFree(p)) return p;
  }
  return null; // semua sibuk
}

const HTTP_PORT = await findFreePort(PREFERRED_PORT);
if (HTTP_PORT === null) {
  logger.error(
    { triedFrom: PREFERRED_PORT, triedTo: PREFERRED_PORT + 9 },
    'Semua port 3001-3010 sibuk. Kill process lama atau set CAPCUT_LOGIN_PORT ke port lain.'
  );
  process.exit(1);
}
if (HTTP_PORT !== PREFERRED_PORT) {
  logger.warn(
    { preferred: PREFERRED_PORT, actual: HTTP_PORT },
    `Port ${PREFERRED_PORT} sibuk, pakai port ${HTTP_PORT} sebagai gantinya.`
  );
}

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
  logger.info(`1. Di terminal lokal (laptop), buka SSH tunnel ke server ini:`);
  logger.info(`     ssh -L ${HTTP_PORT}:localhost:${HTTP_PORT} <user>@<server-host> -p <ssh-port>`);
  logger.info(`   Ganti <user>, <server-host>, <ssh-port> sesuai server kamu.`);
  logger.info(`2. Di browser lokal, buka: http://localhost:${HTTP_PORT}/`);
  logger.info(`3. Scan QR code yang muncul pake aplikasi CapCut di HP:`);
  logger.info(`     Buka CapCut di HP → Profile (tab kanan) → icon Scan di kanan atas`);
  logger.info(`4. Script akan auto-detect login & save session ke ${userDataDir}`);
  logger.info('─────────────────────────');
});

httpServer.on('error', (e) => {
  // Should not happen since we picked a free port above, but just in case.
  logger.error({ err: e.message }, 'HTTP server error');
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

// Track new tabs/popups opened by CapCut (e.g. TikTok OAuth popup)
let popupPage = null;
browser.on('targetcreated', async (target) => {
  const type = target.type();
  const url = target.url();
  logger.info({ type, url: url.slice(0, 100) }, 'New browser target created');
  if (type === 'page' && !popupPage) {
    try {
      popupPage = await target.page();
      if (popupPage) {
        logger.info({ url }, 'Popup/new tab detected, tracking it for QR code');
      }
    } catch (_) {}
  }
});

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

// ====== Step 1: Click "Continue with CapCut Mobile" to reveal QR code ======
// CapCut login page menampilkan 5 opsi login (Google, Email, TikTok, Facebook, CapCut Mobile).
// QR code HANYA muncul setelah klik "Continue with CapCut Mobile".
//
// PENTING: Puppeteer TIDAK support :has-text() pseudo-selector (itu Playwright syntax).
// Pakai page.evaluate dengan querySelectorAll + textContent filter sebagai gantinya.
logger.info('Looking for "Continue with CapCut Mobile" button...');

// Daftar teks yang mungkin di tombol mobile login (case-insensitive)
const MOBILE_BTN_TEXTS = [
  'Continue with CapCut Mobile',
  'CapCut Mobile',
  'Sign in with CapCut Mobile',
  'Login with CapCut Mobile',
  '扫码登录',           // Chinese: scan QR to login
  '掃碼登入',           // Traditional Chinese
  'Scan to login',
  'Scan QR',
  'QR Code Login',
];

async function findMobileLoginButton() {
  // Strategy 1: find clickable element by text content
  const result = await page.evaluate((texts) => {
    const lowerTexts = texts.map((t) => t.toLowerCase());
    const clickableSelectors = 'button, a, div[role="button"], span[role="button"], [class*="btn" i], [class*="button" i]';

    const candidates = Array.from(document.querySelectorAll(clickableSelectors));
    for (const el of candidates) {
      // Get text from element AND its children, trimmed
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      if (!text || text.length > 100) continue; // skip huge elements / empty

      const matches = lowerTexts.some((t) => text === t || text.includes(t));
      if (!matches) continue;

      // Skip elements with very small size (icons, hidden)
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 20) continue;
      if (rect.top < 0 || rect.left < 0) continue;

      // Skip if text contains "continue with google" or other non-mobile
      if (text.includes('google') || text.includes('email') || text.includes('tiktok') || text.includes('facebook')) {
        continue;
      }

      // Found it! Return selector info
      el.setAttribute('data-capcut-mobile-btn', 'true');
      return {
        found: true,
        text: text.slice(0, 80),
        tag: el.tagName.toLowerCase(),
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
      };
    }
    return { found: false };
  }, MOBILE_BTN_TEXTS);

  return result;
}

async function findQrCanvasOrImg() {
  // Look for QR code element in modal/popup using multiple strategies
  return await page.evaluate(() => {
    // Strategy 1: canvas with reasonable QR dimensions (200-400px square)
    const canvases = Array.from(document.querySelectorAll('canvas'));
    for (const c of canvases) {
      const rect = c.getBoundingClientRect();
      // QR codes are usually square, 100-400px
      if (Math.abs(rect.width - rect.height) < 20 && rect.width >= 100 && rect.width <= 500) {
        // Skip if it's the CapCut logo or something
        const parent = c.parentElement;
        const parentClass = parent ? parent.className.toLowerCase() : '';
        if (parentClass.includes('logo') || parentClass.includes('icon')) continue;
        return {
          found: true,
          type: 'canvas',
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          parentClass: parentClass.slice(0, 80),
        };
      }
    }

    // Strategy 2: img with qr-ish src or alt
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const i of imgs) {
      const src = (i.src || '').toLowerCase();
      const alt = (i.alt || '').toLowerCase();
      const rect = i.getBoundingClientRect();
      if (rect.width < 80) continue;
      if (src.includes('qr') || alt.includes('qr') ||
          (src.startsWith('data:image/png;base64,') && rect.width >= 100 && Math.abs(rect.width - rect.height) < 30)) {
        return {
          found: true,
          type: 'img',
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          src: src.slice(0, 80),
        };
      }
    }

    // Strategy 3: SVG with class containing qr
    const svgs = Array.from(document.querySelectorAll('svg'));
    for (const s of svgs) {
      const cls = (s.className?.baseVal || s.getAttribute('class') || '').toLowerCase();
      const rect = s.getBoundingClientRect();
      if (cls.includes('qr') && rect.width >= 100) {
        return {
          found: true,
          type: 'svg',
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          cls: cls.slice(0, 80),
        };
      }
    }

    // Strategy 4: any element with qr in class name that's reasonably sized
    const qrEls = Array.from(document.querySelectorAll('[class*="qr" i], [class*="qrcode" i], [class*="scan" i]'));
    for (const el of qrEls) {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || '').toLowerCase();
      // Skip "Continue with CapCut Mobile" button (it has qr icon class)
      if (text.includes('continue with')) continue;
      if (rect.width < 100 || rect.height < 100) continue;
      return {
        found: true,
        type: 'element',
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        cls: (el.className || '').toString().slice(0, 80),
      };
    }

    return { found: false };
  });
}

let mobileBtnClicked = false;
let mobileBtnInfo = null;

for (let attempt = 0; attempt < 8 && !mobileBtnClicked; attempt++) {
  try {
    mobileBtnInfo = await findMobileLoginButton();
    if (mobileBtnInfo.found) {
      logger.info({ attempt, ...mobileBtnInfo }, 'Found CapCut Mobile button, clicking...');

      // Compute center coordinates of the button
      const centerX = mobileBtnInfo.left + mobileBtnInfo.width / 2;
      const centerY = mobileBtnInfo.top + mobileBtnInfo.height / 2;

      // Use page.mouse for a REAL trusted mouse click (not JS synthetic event).
      // React/Vue SPA frameworks often ignore dispatchEvent() — they need real
      // trusted events with proper mouse move → down → up sequence.
      try {
        // Move mouse to button first (some SPA frameworks need mouseover)
        await page.mouse.move(centerX, centerY, { steps: 5 });
        await new Promise((r) => setTimeout(r, 200));
        // Real click via Puppeteer mouse (sends trusted OS-level event)
        await page.mouse.click(centerX, centerY, { delay: 50 });
        mobileBtnClicked = true;
        logger.info({ x: centerX, y: centerY }, 'Real mouse click sent to button center');
      } catch (e) {
        logger.warn({ err: e.message }, 'Mouse click failed, trying element.click() fallback');
        // Fallback: use elementHandle.click() (Puppeteer's native click)
        try {
          const handle = await page.$('[data-capcut-mobile-btn="true"]');
          if (handle) {
            await handle.click();
            mobileBtnClicked = true;
            logger.info('ElementHandle.click() fallback succeeded');
          }
        } catch (e2) {
          logger.warn({ err: e2.message }, 'ElementHandle.click() also failed');
        }
      }

      // Remove the data attribute for cleanliness
      await page.evaluate(() => {
        const btn = document.querySelector('[data-capcut-mobile-btn="true"]');
        if (btn) btn.removeAttribute('data-capcut-mobile-btn');
      });

      if (mobileBtnClicked) break;
    }
  } catch (e) {
    logger.warn({ err: e.message, attempt }, 'Error finding mobile button');
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
  logger.info('Waiting for QR code modal to render...');
  await new Promise((r) => setTimeout(r, 3000));

  // Diagnostic: check what changed after click
  const diag = await page.evaluate(() => {
    const allPages = window.length; // number of frames
    const canvases = document.querySelectorAll('canvas').length;
    const iframes = document.querySelectorAll('iframe').length;
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="popup" i], [class*="dialog" i]').length;
    // Check for any newly-visible overlay
    const overlays = Array.from(document.querySelectorAll('div'))
      .filter((d) => {
        const s = getComputedStyle(d);
        const rect = d.getBoundingClientRect();
        return (
          (s.position === 'fixed' || s.position === 'absolute') &&
          rect.width > 200 &&
          rect.height > 200 &&
          s.zIndex !== 'auto' &&
          parseInt(s.zIndex || '0', 10) > 100
        );
      }).length;
    return { allPages, canvases, iframes, dialogs, overlays, url: location.href };
  }).catch(() => ({}));
  logger.info({ diag }, 'Post-click diagnostics (canvases, iframes, dialogs, overlays)');

  // List all iframes with their src + position (CapCut Mobile login uses an iframe!)
  const iframeInfos = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('iframe')).map((f) => {
      const r = f.getBoundingClientRect();
      return {
        src: (f.src || '').slice(0, 150),
        width: r.width,
        height: r.height,
        top: r.top,
        left: r.left,
        visible: r.width > 0 && r.height > 0,
      };
    });
  }).catch(() => []);
  logger.info({ iframeCount: iframeInfos.length, iframes: iframeInfos }, 'Iframes on page');

  // Take a screenshot to see if click worked
  const afterClickPath = path.join(screenshotDir, 'after-click.png');
  await page.screenshot({ path: afterClickPath, fullPage: false }).catch(() => {});
  logger.info({ path: afterClickPath }, 'Screenshot after click saved');

  // List all puppeteer frames (can access same-origin iframe content)
  const allFrames = page.frames();
  logger.info(
    {
      frameCount: allFrames.length,
      frames: allFrames.map((f) => ({ url: f.url().slice(0, 120) })),
    },
    'All frames (main + iframes)'
  );

  // Check all open pages/tabs (maybe QR opened in new tab)
  const allPages = await browser.pages();
  logger.info({ pageCount: allPages.length, urls: allPages.map((p) => p.url().slice(0, 80)) }, 'All open browser pages');

  // If popup detected, wait for it to fully load and screenshot it
  if (popupPage) {
    logger.info({ popupUrl: popupPage.url() }, 'Popup page detected, waiting for it to load...');
    try {
      await popupPage.waitForLoadState?.({ waitUntil: 'load', timeout: 10000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
      const popupUrl = popupPage.url();
      logger.info({ popupUrl }, 'Popup page URL after wait');
      // Take screenshot of popup page directly
      const popupShotPath = path.join(screenshotDir, 'popup-qr.png');
      await popupPage.screenshot({ path: popupShotPath, fullPage: false }).catch((e) => {
        logger.warn({ err: e.message }, 'Popup screenshot failed');
      });
      // Also save as qr-latest.png so HTTP viewer shows it
      await popupPage.screenshot({ path: qrLatestPath, fullPage: false }).catch(() => {});
      logger.info({ popupShotPath, qrLatestPath }, 'Popup screenshot saved!');
    } catch (e) {
      logger.warn({ err: e.message }, 'Error while waiting for popup');
    }
  }
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
    // Use popupPage if it exists (where QR code lives), otherwise main page
    const activePage = popupPage && !popupPage.isClosed() ? popupPage : page;
    const currentUrl = activePage.url();

    // Cek 1: URL berubah dari /login atau /scan-qr-code (redirect ke home/dashboard)
    const stillOnLogin = /\/login|\/scan-qr-code/i.test(currentUrl);

    // Cek 2: cookies session (check both pages, cookies are shared per profile)
    const cookies = await page.cookies();
    const sessionCookie = cookies.find(
      (c) =>
        /session|token|uid|passport|login|sid|tt_csrf|s_v_web_id/i.test(c.name) && c.value && c.value.length > 10
    );

    // Cek 3: avatar / user element di header (check main page)
    let avatarFound = false;
    if (!stillOnLogin) {
      try {
        avatarFound = await page.$(
          '[class*="avatar" i], [data-e2e*="user" i], [data-testid*="user" i], [class*="user-info" i], [class*="header-user" i], [class*="account" i]'
        ) ? true : false;
      } catch (_) {}
    }

    if (sessionCookie && (!stillOnLogin || avatarFound)) {
      logger.info({ url: currentUrl, cookie: sessionCookie?.name, avatarFound }, 'LOGIN SUCCESS detected!');
      return 'success';
    }

    // Screenshot QR code — prefer popupPage (where QR actually is)
    const now = Date.now();
    if (now - lastScreenshotTime > 1500) {
      try {
        if (popupPage && !popupPage.isClosed()) {
          // Screenshot the popup page (QR code lives here!)
          await popupPage.screenshot({ path: qrLatestPath, fullPage: false }).catch(() => {});
          if (!qrFound) {
            logger.info({ popupUrl: popupPage.url() }, 'Capturing QR from popup page');
            qrFound = true;
          }
        } else {
          // Fallback: try to find QR element on main page
          const found = await findQrCanvasOrImg();
          if (found && found.found) {
            if (!qrFound) {
              logger.info(
                { type: found.type, w: Math.round(found.width), h: Math.round(found.height) },
                'QR code element detected on main page, capturing...'
              );
              qrFound = true;
            }
            await page.screenshot({
              path: qrLatestPath,
              clip: {
                x: Math.max(0, found.left - 30),
                y: Math.max(0, found.top - 30),
                width: found.width + 60,
                height: found.height + 60,
              },
            });
          } else {
            await page.screenshot({ path: qrLatestPath, fullPage: false });
          }
        }
        lastScreenshotTime = now;

        // Save periodic debug screenshot
        if (tries % 5 === 0) {
          const debugPath = path.join(screenshotDir, `debug-${tries}.png`);
          await activePage.screenshot({ path: debugPath, fullPage: false }).catch(() => {});
        }
      } catch (e) {
        logger.warn({ err: e.message }, 'Screenshot error');
      }
    }

    if (tries % 6 === 0) {
      logger.info(
        { tries, elapsedS: Math.round(elapsedMs / 1000), url: currentUrl, qrFound, hasSessionCookie: !!sessionCookie, mobileBtnClicked, popupAlive: popupPage && !popupPage.isClosed() },
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
