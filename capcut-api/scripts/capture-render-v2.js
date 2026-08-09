// scripts/capture-render-v2.js
//
// Reverse-engineer CapCut internal render API — v2 (no interception, no screenshots).
//
// Strategi:
//   1. Launch puppeteer pakai .capcut-profile (sudah login).
//   2. Pasang request/response listener PASSIF (no setRequestInterception).
//      Request interception bikin puppeteer hang di editor SPA.
//   3. Buka editor-template?create_id=<template_id>
//   4. Upload 2 image test-assets via file input.
//   5. Klik Export → tunggu render selesai.
//   6. Semua POST + GET ke capcut domains di-log ke file.
//
// Output: tmp/api-capture-v2-<timestamp>.jsonl

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
const CAPTURE_FILE = path.join(TMP_DIR, `api-capture-v2-${ts}.jsonl`);
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

function truncateBody(body, maxLen = 12000) {
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
  // Skip static assets
  const u = url.toLowerCase();
  if (/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|map|webp|mp4|webm|m3u8|ts)(\?|$)/.test(u)) return false;
  if (/\/static\//.test(u)) return false;
  if (/sentry|datadog|log\.custom|report\.custom|analytics/i.test(u)) return false;
  // Capture all XHR/fetch to capcut domains
  if (/capcut\.com|capcutapi\.com|byteoversea\.com|bytedance\.com|byteimg\.com|ibyteimg\.com|tiktokcdn\.com|pstatp\.com|tosv\.org|tos-alisg\.com|16cv\.com/.test(u)) return true;
  return false;
}

async function main() {
  const templateId = process.argv[2] || process.env.TEMPLATE_ID;
  if (!templateId) {
    console.error('Usage: node scripts/capture-render-v2.js <templateId>');
    process.exit(1);
  }

  const testImages = [
    path.join(projectRoot, 'test-assets', 'img1.jpg'),
    path.join(projectRoot, 'test-assets', 'img2.jpg'),
  ].filter(p => fs.existsSync(p));

  if (testImages.length === 0) {
    console.error('No test images in test-assets/');
    process.exit(1);
  }

  // Cleanup locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true });
  }

  console.log(`[v2] Template: ${templateId}`);
  console.log(`[v2] Capture file: ${CAPTURE_FILE}`);
  console.log(`[v2] Images: ${testImages.length}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: USER_DATA_DIR,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle',
      '--mute-audio', '--no-first-run', '--no-default-browser-check',
    ],
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setDefaultTimeout(60000);
  await page.setDefaultNavigationTimeout(60000);

  // CDP session for richer network info
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');

  let reqCounter = 0;
  const reqMap = new Map(); // requestId -> {url, method, postData}

  // CDP Network events — passive, no interception
  client.on('Network.requestWillBeSent', (params) => {
    const { requestId, request, type } = params;
    if (!shouldCapture(request.url)) return;
    reqCounter++;
    reqMap.set(requestId, { seq: reqCounter, url: request.url, method: request.method });
    const entry = {
      seq: reqCounter,
      ts: Date.now(),
      kind: 'request',
      method: request.method,
      url: request.url,
      resourceType: type,
      headers: safeStringify(request.headers, 3000),
      postData: request.method !== 'GET' ? truncateBody(request.postData, 12000) : null,
    };
    logCapture(entry);
  });

  client.on('Network.responseReceived', async (params) => {
    const { requestId, response } = params;
    const reqInfo = reqMap.get(requestId);
    if (!reqInfo) return;
    const ct = response.headers['content-type'] || '';
    let bodySummary = null;
    // Don't fetch body here — too slow. Just record metadata.
    const entry = {
      seq: reqInfo.seq,
      ts: Date.now(),
      kind: 'response_meta',
      method: reqInfo.method,
      url: reqInfo.url,
      status: response.status,
      contentType: ct,
      headers: safeStringify(response.headers, 1500),
    };
    logCapture(entry);
  });

  client.on('Network.loadingFinished', async (params) => {
    const { requestId } = params;
    const reqInfo = reqMap.get(requestId);
    if (!reqInfo) return;
    // Try fetch body for small text responses
    try {
      const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId });
      if (base64Encoded) {
        // decode
        const decoded = Buffer.from(body, 'base64').toString('utf8');
        const entry = {
          seq: reqInfo.seq,
          ts: Date.now(),
          kind: 'response_body',
          url: reqInfo.url,
          body: truncateBody(decoded, 16000),
        };
        logCapture(entry);
      } else {
        const entry = {
          seq: reqInfo.seq,
          ts: Date.now(),
          kind: 'response_body',
          url: reqInfo.url,
          body: truncateBody(body, 16000),
        };
        logCapture(entry);
      }
    } catch (e) {
      // body fetch failed — that's ok
    }
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      logCapture({ ts: Date.now(), kind: 'console', type: msg.type(), text: msg.text().slice(0, 1000) });
    }
  });

  try {
    console.log('[v2] Navigating to editor...');
    const editorUrl = `https://www.capcut.com/editor-template?create_id=${templateId}`;
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (/\/login/.test(page.url())) {
      throw new Error('Session expired - redirected to login');
    }

    console.log('[v2] Waiting 25s for SPA...');
    await new Promise(r => setTimeout(r, 25000));

    // Close modals via evaluate (fast, single call)
    console.log('[v2] Closing modals...');
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) {
        const btn = document.querySelector('.lv-modal-close-icon, [class*="modal-close" i]');
        if (btn) btn.click();
        const mask = document.querySelector('.lv-modal-mask');
        if (mask) mask.click();
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));

    console.log('[v2] Searching for file input...');
    let fileInput = null;
    for (let i = 0; i < 10 && !fileInput; i++) {
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
      throw new Error('File input not found after 15s');
    }
    console.log('[v2] Uploading images...');
    await fileInput.uploadFile(...testImages);
    await new Promise(r => setTimeout(r, 20000));

    // Close any post-upload modals
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) {
        const btn = document.querySelector('.lv-modal-close-icon, [class*="modal-close" i]');
        if (btn) btn.click();
      }
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    console.log('[v2] Looking for Export button...');
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
    console.log('[v2] Clicking Export...');
    await exportBtn.click();
    await new Promise(r => setTimeout(r, 3000));

    // Click confirm button if export dialog
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
      console.log('[v2] Clicked confirm export');
    } catch {}
    await new Promise(r => setTimeout(r, 2000));

    console.log('[v2] Waiting for render (up to 5 min)...');
    const renderStart = Date.now();
    let downloadUrl = null;
    let lastProgressLog = 0;
    while (Date.now() - renderStart < 300000) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        downloadUrl = await page.$eval('a[download], a[href*=".mp4"]', el => el.href).catch(() => null);
      } catch {}
      if (downloadUrl) {
        console.log(`[v2] ✓ Download URL: ${downloadUrl}`);
        break;
      }
      // Log progress every 15s
      if (Date.now() - lastProgressLog > 15000) {
        const elapsed = Math.round((Date.now() - renderStart) / 1000);
        console.log(`[v2] Still rendering... ${elapsed}s elapsed`);
        lastProgressLog = Date.now();
      }
    }

    if (downloadUrl) {
      console.log('[v2] ✓ Render completed');
    } else {
      console.log('[v2] ✗ Render did not complete in 5 min');
    }
  } catch (err) {
    console.error('[v2] Error:', err.message);
    logCapture({ ts: Date.now(), kind: 'error', message: err.message, stack: err.stack });
  } finally {
    captureStream.end();
    await new Promise(r => captureStream.on('finish', r));
    console.log(`[v2] Capture saved to ${CAPTURE_FILE}`);
    await browser.close();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
