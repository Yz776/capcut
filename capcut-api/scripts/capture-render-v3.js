// scripts/capture-render-v3.js
//
// Reverse-engineer CapCut internal render API — v3 (xvfb + non-headless).
//
// Key insight: CapCut editor needs WebGL. Without GPU/display, it hangs at
// file input stage. Solution: run under xvfb (virtual X display) with
// headless:false so WebGL has a display.
//
// Output: tmp/api-capture-v3-<timestamp>.jsonl

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const USER_DATA_DIR = path.join(projectRoot, '.capcut-profile');
const TMP_DIR = path.join(projectRoot, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const ts = Date.now();
const CAPTURE_FILE = path.join(TMP_DIR, `api-capture-v3-${ts}.jsonl`);
const captureStream = fs.createWriteStream(CAPTURE_FILE, { flags: 'a' });

function logCapture(entry) {
  captureStream.write(JSON.stringify(entry) + '\n');
}

function safeStringify(obj, maxLen = 8000) {
  try {
    const s = JSON.stringify(obj);
    if (s.length > maxLen) return s.slice(0, maxLen) + '...[TRUNCATED]';
    return s;
  } catch (e) { return `[unserializable: ${e.message}]`; }
}

function truncateBody(body, maxLen = 16000) {
  if (!body) return null;
  if (typeof body === 'string') {
    if (body.length > maxLen) return body.slice(0, maxLen) + '...[TRUNCATED]';
    return body;
  }
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
    return `<binary ${body.byteLength || body.length} bytes>`;
  }
  return safeStringify(body, maxLen);
}

function shouldCapture(url) {
  const u = url.toLowerCase();
  if (/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|map|webp|mp4|webm|m3u8|ts)(\?|$)/.test(u)) return false;
  if (/\/static\//.test(u)) return false;
  if (/sentry|datadog|analytics/i.test(u)) return false;
  if (/capcut\.com|capcutapi\.com|byteoversea\.com|bytedance\.com|byteimg\.com|ibyteimg\.com|tiktokcdn\.com|pstatp\.com|tosv\.org|tos-alisg\.com|16cv\.com/.test(u)) return true;
  return false;
}

async function main() {
  const templateId = process.argv[2] || process.env.TEMPLATE_ID;
  if (!templateId) {
    console.error('Usage: node scripts/capture-render-v3.js <templateId>');
    process.exit(1);
  }

  const testImages = [
    path.join(projectRoot, 'test-assets', 'img1.jpg'),
    path.join(projectRoot, 'test-assets', 'img2.jpg'),
  ].filter(p => fs.existsSync(p));

  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true });
  }

  console.log(`[v3] Template: ${templateId}`);
  console.log(`[v3] Capture: ${CAPTURE_FILE}`);
  console.log(`[v3] Display: ${process.env.DISPLAY || '(none)'}`);

  const browser = await puppeteer.launch({
    headless: false, // NON-headless — needs xvfb
    userDataDir: USER_DATA_DIR,
    defaultViewport: null, // use natural window size
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--enable-webgl', '--ignore-gpu-blocklist',
      '--use-gl=angle', '--angle-backend=swiftshader', // software GL
      '--enable-features=Vulkan',
      '--disable-gpu-sandbox',
      '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--window-size=1440,900',
    ],
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setDefaultTimeout(60000);
  await page.setDefaultNavigationTimeout(60000);

  const client = await page.target().createCDPSession();
  await client.send('Network.enable');

  let reqCounter = 0;
  const reqMap = new Map();

  client.on('Network.requestWillBeSent', (params) => {
    const { requestId, request, type } = params;
    if (!shouldCapture(request.url)) return;
    reqCounter++;
    reqMap.set(requestId, { seq: reqCounter, url: request.url, method: request.method });
    logCapture({
      seq: reqCounter,
      ts: Date.now(),
      kind: 'request',
      method: request.method,
      url: request.url,
      resourceType: type,
      headers: safeStringify(request.headers, 3000),
      postData: request.method !== 'GET' ? truncateBody(request.postData, 16000) : null,
    });
  });

  client.on('Network.responseReceived', (params) => {
    const { requestId, response } = params;
    const reqInfo = reqMap.get(requestId);
    if (!reqInfo) return;
    logCapture({
      seq: reqInfo.seq,
      ts: Date.now(),
      kind: 'response_meta',
      method: reqInfo.method,
      url: reqInfo.url,
      status: response.status,
      contentType: response.headers['content-type'] || '',
      headers: safeStringify(response.headers, 1500),
    });
  });

  client.on('Network.loadingFinished', async (params) => {
    const { requestId } = params;
    const reqInfo = reqMap.get(requestId);
    if (!reqInfo) return;
    try {
      const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId });
      const decoded = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      logCapture({
        seq: reqInfo.seq,
        ts: Date.now(),
        kind: 'response_body',
        url: reqInfo.url,
        body: truncateBody(decoded, 20000),
      });
    } catch {}
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      logCapture({ ts: Date.now(), kind: 'console', type: msg.type(), text: msg.text().slice(0, 1000) });
    }
  });

  try {
    console.log('[v3] Navigating to editor...');
    const editorUrl = `https://www.capcut.com/editor-template?create_id=${templateId}`;
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (/\/login/.test(page.url())) {
      throw new Error('Session expired - redirected to login');
    }

    console.log('[v3] Waiting 30s for SPA + WebGL...');
    await new Promise(r => setTimeout(r, 30000));

    console.log('[v3] Closing modals...');
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) {
        const btn = document.querySelector('.lv-modal-close-icon, [class*="modal-close" i]');
        if (btn) btn.click();
        const mask = document.querySelector('.lv-modal-mask');
        if (mask) mask.click();
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    console.log('[v3] Searching for file input...');
    let fileInput = null;
    for (let i = 0; i < 15 && !fileInput; i++) {
      fileInput = await page.$('input[type="file"]').catch(() => null);
      if (fileInput) break;
      try {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [class*="upload" i]'));
          const target = btns.find(el => {
            const t = (el.innerText || el.textContent || '').toLowerCase();
            return t.includes('upload') || t.includes('import');
          });
          if (target) target.click();
        });
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }

    if (!fileInput) {
      throw new Error('File input not found after 22s');
    }

    console.log('[v3] Uploading images...');
    await fileInput.uploadFile(...testImages);
    await new Promise(r => setTimeout(r, 25000));

    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) {
        const btn = document.querySelector('.lv-modal-close-icon, [class*="modal-close" i]');
        if (btn) btn.click();
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    console.log('[v3] Looking for Export button...');
    let exportBtn = null;
    for (let i = 0; i < 30; i++) {
      exportBtn = await page.$('button.export-video-btn:not(.lv-btn-disabled)').catch(() => null);
      if (exportBtn) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!exportBtn) {
      exportBtn = await page.$('button.export-video-btn').catch(() => null);
    }
    if (!exportBtn) {
      throw new Error('Export button not found');
    }
    console.log('[v3] Clicking Export...');
    await exportBtn.click();
    await new Promise(r => setTimeout(r, 3000));

    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.find(el => {
          const t = (el.innerText || el.textContent || '').toLowerCase().trim();
          return ['export', 'confirm', 'done', 'render'].includes(t)
            && !el.classList.contains('lv-btn-disabled') && !el.disabled;
        });
        if (target) target.click();
      });
      console.log('[v3] Clicked confirm export');
    } catch {}
    await new Promise(r => setTimeout(r, 2000));

    console.log('[v3] Waiting for render (up to 6 min)...');
    const renderStart = Date.now();
    let downloadUrl = null;
    let lastProgressLog = 0;
    while (Date.now() - renderStart < 360000) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        downloadUrl = await page.$eval('a[download], a[href*=".mp4"]', el => el.href).catch(() => null);
      } catch {}
      if (downloadUrl) {
        console.log(`[v3] ✓ Download URL: ${downloadUrl}`);
        break;
      }
      if (Date.now() - lastProgressLog > 15000) {
        const elapsed = Math.round((Date.now() - renderStart) / 1000);
        console.log(`[v3] Still rendering... ${elapsed}s elapsed`);
        lastProgressLog = Date.now();
      }
    }

    if (downloadUrl) {
      console.log('[v3] ✓ Render completed');
    } else {
      console.log('[v3] ✗ Render did not complete in 6 min');
    }
  } catch (err) {
    console.error('[v3] Error:', err.message);
    logCapture({ ts: Date.now(), kind: 'error', message: err.message, stack: err.stack });
  } finally {
    captureStream.end();
    await new Promise(r => captureStream.on('finish', r));
    console.log(`[v3] Capture saved to ${CAPTURE_FILE}`);
    await browser.close();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
