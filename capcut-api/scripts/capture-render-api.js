// scripts/capture-render-api.js
//
// Reverse-engineer CapCut internal render API.
//
// Strategi:
//   1. Launch puppeteer pakai .capcut-profile (sudah login).
//   2. Pasang request/response listener — log SEMUA XHR/fetch ke file.
//   3. Buka editor-template?create_id=<template_id>
//   4. Upload 2 image test-assets.
//   5. Klik Export → tunggu render selesai → download MP4.
//   6. Semua request yang lewat selama sesi ini dicatat dengan:
//      URL, method, headers, body, response status, response body.
//   7. Filter khusus: cari pattern "/api/", "/luckycat/", "/render/", "/export/",
//      "/draft/", "/compile/", "/lapi/", "/mcp/", "/vedit/".
//
// Output: tmp/api-capture-<timestamp>.jsonl (satu JSON per line)
//         tmp/api-capture-summary-<timestamp>.md (ringkasan endpoint render candidates)

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
const CAPTURE_FILE = path.join(TMP_DIR, `api-capture-${ts}.jsonl`);
const SUMMARY_FILE = path.join(TMP_DIR, `api-capture-summary-${ts}.md`);
const SCREENSHOT_DIR = path.join(TMP_DIR, `api-capture-shots-${ts}`);
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Patterns yang dicurigai sebagai render API
const RENDER_API_PATTERNS = [
  /\/api\//i,
  /\/luckycat\//i,
  /\/render/i,
  /\/export/i,
  /\/draft/i,
  /\/compile/i,
  /\/lapi\//i,
  /\/mcp\//i,
  /\/vedit/i,
  /\/cutout/i,
  /\/v1\//i,
  /\/v2\//i,
  /\/task/i,
  /\/job/i,
  /\/project/i,
  /\/publish/i,
  /\/upload/i,
  /\/tts/i,
  /\/aigc/i,
  /\/material/i,
  /\/editor/i,
  /\/create/i,
];

// Domain yang relevan
const INTERESTING_DOMAINS = [
  'capcut.com',
  'capcutapi.com',
  'bytedance.com',
  'byteoversea.com',
  'ibyteimg.com',
  'ibytecdn.com',
  'byteimg.com',
  'tiktokcdn.com',
  'mssdk.com',
  'snssdk.com',
  '16cv.com',
  'effectmelive.com',
  'pstatp.com',
  'tosv.org',
  'tos-alisg.com',
];

const captureStream = fs.createWriteStream(CAPTURE_FILE, { flags: 'a' });

// Module-scoped page reference so safeScreenshot helper can access it.
let _page = null;

function logCapture(entry) {
  captureStream.write(JSON.stringify(entry) + '\n');
}

async function safeScreenshot(name) {
  if (!_page) return;
  try {
    await _page.screenshot({ path: path.join(SCREENSHOT_DIR, name) });
    console.log(`[capture] screenshot: ${name}`);
  } catch (e) {
    console.log(`[capture] screenshot FAILED ${name}: ${e.message}`);
  }
}

function isInteresting(url) {
  try {
    const u = new URL(url);
    const dom = u.hostname;
    const isRelevantDomain = INTERESTING_DOMAINS.some(d => dom.includes(d));
    const matchesRenderPattern = RENDER_API_PATTERNS.some(p => p.test(u.pathname));
    // Always capture XHR/fetch to capcut.com domain
    if (dom.includes('capcut.com')) return true;
    // Capture if URL matches render pattern AND domain is interesting
    if (matchesRenderPattern && isRelevantDomain) return true;
    // Capture POST requests to any domain (potential render submit)
    return false;
  } catch {
    return false;
  }
}

function safeStringify(obj, maxLen = 4000) {
  try {
    const s = JSON.stringify(obj);
    if (s.length > maxLen) return s.slice(0, maxLen) + '...[TRUNCATED]';
    return s;
  } catch (e) {
    return `[unserializable: ${e.message}]`;
  }
}

function truncateBody(body, maxLen = 8000) {
  if (!body) return null;
  if (typeof body === 'string') {
    if (body.length > maxLen) return body.slice(0, maxLen) + '...[TRUNCATED]';
    return body;
  }
  if (body instanceof Buffer || ArrayBuffer.isView(body)) {
    return `<binary ${body.byteLength || body.length} bytes>`;
  }
  return safeStringify(body, maxLen);
}

async function getResponseBufferSafe(response, maxLen = 16000) {
  try {
    const buf = await response.buffer();
    if (buf.length > maxLen) {
      const preview = buf.slice(0, maxLen).toString('utf8');
      return preview + `\n...[TRUNCATED total ${buf.length} bytes]`;
    }
    // Try parse as JSON
    const text = buf.toString('utf8');
    try {
      const obj = JSON.parse(text);
      return safeStringify(obj, maxLen);
    } catch {
      return text;
    }
  } catch (e) {
    return `[buffer read failed: ${e.message}]`;
  }
}

function isProbablyApiRequest(url, method) {
  const u = url.toLowerCase();
  // Skip static asset endpoints
  if (/\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|map)(\?|$)/.test(u)) return false;
  if (/\/static\//.test(u)) return false;
  if (/sentry|analytics|google|facebook|tiktok\.com\/i18n|datadog|log\.custom|report/i.test(u)) return false;
  // API-like paths
  if (/\/api\//.test(u)) return true;
  if (/\/luckycat\//.test(u)) return true;
  if (/\/lapi\//.test(u)) return true;
  if (/\/mcp\//.test(u)) return true;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return true;
  if (/render|export|compile|draft|task|job|project|publish|create|upload|material|editor/i.test(u)) return true;
  return false;
}

async function main() {
  const templateId = process.argv[2] || process.env.TEMPLATE_ID;
  if (!templateId) {
    console.error('Usage: node scripts/capture-render-api.js <templateId>');
    console.error('       TEMPLATE_ID=xxx node scripts/capture-render-api.js');
    process.exit(1);
  }

  const testImages = [
    path.join(projectRoot, 'test-assets', 'img1.jpg'),
    path.join(projectRoot, 'test-assets', 'img2.jpg'),
  ].filter(p => fs.existsSync(p));

  if (testImages.length === 0) {
    console.error('No test images found in test-assets/');
    process.exit(1);
  }

  // Cleanup stale chromium locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true });
  }

  console.log(`[capture] Template ID: ${templateId}`);
  console.log(`[capture] Test images: ${testImages.length}`);
  console.log(`[capture] Capture file: ${CAPTURE_FILE}`);
  console.log(`[capture] Screenshot dir: ${SCREENSHOT_DIR}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: USER_DATA_DIR,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=9223',
    ],
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  _page = page;
  await page.setDefaultTimeout(90000);
  await page.setDefaultNavigationTimeout(90000);

  let reqCounter = 0;
  const renderCandidates = [];
  const postRequests = [];

  // === INTERCEPT REQUESTS ===
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    reqCounter++;
    const url = req.url();
    const method = req.method();
    const type = req.resourceType();
    const headers = req.headers();
    let postData = req.postData();

    if (isProbablyApiRequest(url, method)) {
      const entry = {
        seq: reqCounter,
        ts: Date.now(),
        kind: 'request',
        method,
        url,
        resourceType: type,
        headers: safeStringify(headers, 2000),
        postData: truncateBody(postData, 12000),
      };
      logCapture(entry);

      if (method === 'POST') {
        postRequests.push({ seq: reqCounter, url, postData });
      }
      // Mark render-candidate if URL looks like render/export/compile
      if (/render|export|compile|draft|publish|create|task|job/i.test(url)) {
        renderCandidates.push({ seq: reqCounter, method, url, postData: truncateBody(postData, 4000) });
      }
    }
    req.continue();
  });

  page.on('response', async (res) => {
    const url = res.url();
    const method = res.request().method();
    if (!isProbablyApiRequest(url, method)) return;
    const status = res.status();
    let respBody = null;
    const ct = res.headers()['content-type'] || '';
    if (ct.includes('json') || ct.includes('text') || ct.includes('javascript')) {
      respBody = await getResponseBufferSafe(res, 16000);
    } else {
      // binary — just record size + type
      try {
        const buf = await res.buffer();
        respBody = `<binary ${buf.length} bytes, ct=${ct}>`;
      } catch (e) {
        respBody = `[read failed: ${e.message}]`;
      }
    }
    const entry = {
      seq: reqCounter,
      ts: Date.now(),
      kind: 'response',
      method,
      url,
      status,
      contentType: ct,
      body: truncateBody(respBody, 16000),
    };
    logCapture(entry);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      logCapture({
        ts: Date.now(),
        kind: 'console',
        type: msg.type(),
        text: msg.text().slice(0, 1000),
      });
    }
  });

  try {
    console.log('[capture] Navigating to editor...');
    const editorUrl = `https://www.capcut.com/editor-template?create_id=${templateId}`;
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

    if (/\/login/.test(page.url())) {
      throw new Error('Session expired - redirected to /login. Run npm run login:manual first.');
    }

    console.log('[capture] Waiting 20s for SPA to load...');
    await new Promise(r => setTimeout(r, 20000));
    await safeScreenshot('01-editor-loaded.png');

    // Close modals
    console.log('[capture] Closing modals...');
    for (let i = 0; i < 5; i++) {
      try {
        const closed = await page.evaluate(() => {
          const btn = document.querySelector('.lv-modal-close-icon, [class*="modal-close" i]');
          if (btn) { btn.click(); return true; }
          const mask = document.querySelector('.lv-modal-mask');
          if (mask) { mask.click(); return true; }
          return false;
        });
        if (!closed) break;
        await new Promise(r => setTimeout(r, 800));
      } catch { break; }
    }

    console.log('[capture] Looking for file input...');
    let fileInput = null;
    for (let i = 0; i < 8 && !fileInput; i++) {
      fileInput = await page.$('input[type="file"]');
      if (fileInput) break;
      // try click upload button
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
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!fileInput) {
      await safeScreenshot('02-no-file-input.png');
      throw new Error('File input not found after 16s');
    }

    console.log('[capture] Uploading images...');
    await fileInput.uploadFile(...testImages);
    await new Promise(r => setTimeout(r, 18000));
    await safeScreenshot('03-images-uploaded.png');

    // Close any modal that appeared
    for (let i = 0; i < 3; i++) {
      try {
        await page.evaluate(() => {
          const btn = document.querySelector('.lv-modal-close-icon, [class*="modal-close" i]');
          if (btn) btn.click();
        });
        await new Promise(r => setTimeout(r, 500));
      } catch {}
    }

    console.log('[capture] Clicking Export...');
    // Wait for export button to be active
    let exportBtn = null;
    for (let i = 0; i < 30; i++) {
      exportBtn = await page.$('button.export-video-btn:not(.lv-btn-disabled)');
      if (exportBtn) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!exportBtn) {
      // Fallback: any export button
      exportBtn = await page.$('button.export-video-btn');
    }
    if (!exportBtn) {
      await safeScreenshot('04-no-export-btn.png');
      throw new Error('Export button not found');
    }
    await exportBtn.click();
    await new Promise(r => setTimeout(r, 3000));
    await safeScreenshot('05-after-export-click.png');

    // Click confirm/done button if export dialog appears
    try {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.find(el => {
          const t = (el.innerText || el.textContent || '').toLowerCase().trim();
          return (t === 'export' || t === 'confirm' || t === 'done' || t === 'render')
            && !el.classList.contains('lv-btn-disabled') && !el.disabled;
        });
        if (target) target.click();
      });
      console.log('[capture] Clicked confirm export');
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
    await safeScreenshot('06-confirm-export.png');

    console.log('[capture] Waiting for render to complete (up to 5 min)...');
    const renderStart = Date.now();
    let downloadUrl = null;
    while (Date.now() - renderStart < 300000) {
      await new Promise(r => setTimeout(r, 4000));
      try {
        downloadUrl = await page.$eval('a[download], a[href*=".mp4"]', el => el.href).catch(() => null);
      } catch {}
      if (downloadUrl) {
        console.log(`[capture] Download URL detected: ${downloadUrl}`);
        break;
      }
      // Save screenshot every 30s for forensics
      if ((Date.now() - renderStart) % 30000 < 4000) {
        const elapsed = Math.round((Date.now() - renderStart) / 1000);
        await safeScreenshot(`07-rendering-${elapsed}s.png`);
      }
    }
    await safeScreenshot('08-render-done.png');

    if (downloadUrl) {
      console.log('[capture] ✓ Render completed');
    } else {
      console.log('[capture] ✗ Render did not complete in 5 min');
    }
  } catch (err) {
    console.error('[capture] Error:', err.message);
    logCapture({ ts: Date.now(), kind: 'error', message: err.message, stack: err.stack });
  } finally {
    captureStream.end();
    await new Promise(r => captureStream.on('finish', r));

    // Build summary
    let summary = `# CapCut API Capture Summary\n\n`;
    summary += `**Timestamp:** ${new Date(ts).toISOString()}\n`;
    summary += `**Template ID:** ${templateId}\n`;
    summary += `**Capture file:** ${CAPTURE_FILE}\n\n`;
    summary += `## POST Requests (${postRequests.length} total)\n\n`;
    for (const r of postRequests) {
      summary += `### #${r.seq} ${r.url}\n\n`;
      summary += `\`\`\`json\n${r.postData || '(no body)'}\n\`\`\`\n\n`;
    }
    summary += `\n## Render API Candidates (${renderCandidates.length})\n\n`;
    for (const c of renderCandidates) {
      summary += `### #${c.seq} ${c.method} ${c.url}\n\n`;
      if (c.postData) summary += `Body: \`${c.postData.slice(0, 500)}\`\n\n`;
    }
    fs.writeFileSync(SUMMARY_FILE, summary);
    console.log(`[capture] Summary: ${SUMMARY_FILE}`);

    await browser.close();
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
