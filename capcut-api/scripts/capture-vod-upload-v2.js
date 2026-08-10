// scripts/capture-vod-upload-v2.js
//
// V2: Use page.waitForFileChooser() to reliably trigger upload.
// Run with: xvfb-run -a node scripts/capture-vod-upload-v2.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const USER_DATA_DIR = process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');
const OUT_FILE = path.join(projectRoot, 'tmp', 'vod-upload-capture-v2.jsonl');
const TEST_IMAGE = path.join(projectRoot, 'test-assets', 'img1.jpg');

const INTERCEPT_DOMAINS = [
  'bytevcloudapi.com',
  'vodupload.com',
  'bytepluses.com',
  'ibytedtos.com',
  'ibyteimg.com',
  'edit-api-sg.capcut.com',
  'tos-ap-southeast',
  'tos-southeast',
];

function shouldCapture(url) {
  return INTERCEPT_DOMAINS.some(d => url.includes(d));
}

async function main() {
  console.log('=== VOD Upload Network Capture v2 ===');
  console.log(`output: ${OUT_FILE}\n`);

  // Cleanup stale locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true }); } catch {}
  }

  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: null,
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.bringToFront();

  // Set a realistic User-Agent
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const captureStream = fs.createWriteStream(OUT_FILE, { flags: 'w' });
  const allEntries = [];

  page.on('request', (req) => {
    try {
      const url = req.url();
      if (!shouldCapture(url)) return;
      const entry = {
        ts: Date.now(),
        kind: 'request',
        method: req.method(),
        url,
        headers: req.headers(),
        postData: req.postData() ? req.postData().slice(0, 12000) : null,
      };
      allEntries.push(entry);
      captureStream.write(JSON.stringify({ ...entry, headers: JSON.stringify(entry.headers).slice(0, 8000) }) + '\n');
    } catch (e) {}
  });

  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!shouldCapture(url)) return;
      const req = res.request();
      const entry = {
        ts: Date.now(),
        kind: 'response_meta',
        method: req.method(),
        url,
        status: res.status(),
        contentType: res.headers()['content-type'] || '',
        headers: res.headers(),
      };
      allEntries.push(entry);
      captureStream.write(JSON.stringify({ ...entry, headers: JSON.stringify(entry.headers).slice(0, 8000) }) + '\n');

      if (url.includes('bytevcloudapi.com') || url.includes('prepare_upload_cloud') || url.includes('create_cloud_asset') || url.includes('tos-')) {
        try {
          const text = await res.text();
          captureStream.write(JSON.stringify({
            ts: Date.now(),
            kind: 'response_body',
            url,
            body: text.slice(0, 12000),
          }) + '\n');
        } catch {}
      }
    } catch (e) {}
  });

  // Navigate to editor with template
  const templateId = '7617043391162928401';
  const templateUrl = `https://www.capcut.com/editor-template?create_id=${templateId}`;
  console.log(`Navigating to: ${templateUrl}`);

  try {
    await page.goto(templateUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log(`Navigation warning: ${e.message}`);
  }

  console.log('Waiting 50s for editor to fully load...');
  await sleep(50000);
  try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'vod-v2-editor-loaded.png') }); console.log('Screenshot saved'); } catch (e) { console.log('Screenshot failed (continuing):', e.message.slice(0, 80)); }

  // Find all clickable elements with "upload" text
  console.log('\nSearching for upload UI elements...');
  const uploadCandidates = await page.evaluate(() => {
    const result = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    while (node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text || text.length > 30) continue;
      const lower = text.toLowerCase();
      if (lower === 'upload' || lower === 'uploads' || lower.includes('upload') && text.length < 20) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          result.push({
            tag: node.tagName,
            text,
            class: node.className?.toString().slice(0, 80),
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          });
        }
      }
    }
    return result.slice(0, 20);
  }).catch(() => []);
  console.log('Upload candidates:', JSON.stringify(uploadCandidates, null, 2));

  // Wait for file chooser in parallel with click attempts
  console.log('\nSetting up file chooser watcher...');
  const fileChooserPromise = page.waitForFileChooser({ timeout: 120000 }).catch(e => {
    console.log(`fileChooser timeout: ${e.message}`);
    return null;
  });

  // Try clicking upload candidates
  for (const candidate of uploadCandidates.slice(0, 5)) {
    try {
      console.log(`Trying click on "${candidate.text}" (${candidate.tag})...`);
      // Use evaluate to click by coordinates since selectors might not work
      await page.mouse.click(candidate.rect.x + candidate.rect.w / 2, candidate.rect.y + candidate.rect.h / 2);
      await sleep(2000);
      console.log('  clicked, checking for chooser...');
    } catch (e) {
      console.log(`  click failed: ${e.message}`);
    }
  }

  const fileChooser = await fileChooserPromise;
  if (fileChooser) {
    console.log('✓ File chooser opened! Uploading test image...');
    await fileChooser.accept([TEST_IMAGE]);
    console.log('✓ File accepted. Waiting 90s for upload + processing...');
    await sleep(90000);
    try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'vod-v2-after-upload.png') }); console.log('After-upload screenshot saved.'); } catch (e) { console.log('Screenshot failed (continuing):', e.message.slice(0, 80)); }
  } else {
    console.log('✗ No file chooser appeared. Trying to find input[type=file] directly...');
    const inputs = await page.$$('input[type="file"]');
    console.log(`Found ${inputs.length} file inputs`);
    for (let i = 0; i < inputs.length; i++) {
      try {
        await inputs[i].uploadFile(TEST_IMAGE);
        console.log(`✓ Uploaded via input ${i}. Waiting 60s...`);
        await sleep(60000);
        break;
      } catch (e) {
        console.log(`  input ${i} failed: ${e.message}`);
      }
    }
  }

  // Wait a bit more to catch any final API calls
  await sleep(15000);

  // Summary
  console.log(`\n=== Capture summary ===`);
  console.log(`Total entries: ${allEntries.length}`);
  const byKind = allEntries.reduce((acc, e) => {
    const k = e.kind;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log('By kind:', byKind);

  const vodUrls = allEntries
    .filter(e => e.url?.includes('bytevcloudapi.com') || e.url?.includes('bytepluses.com') || e.url?.includes('tos-'))
    .map(e => ({ kind: e.kind, method: e.method, url: e.url, status: e.status }));
  console.log(`\nVOD/TOS calls (${vodUrls.length}):`);
  vodUrls.forEach(u => console.log(`  ${u.kind} ${u.method} ${u.status || ''} ${u.url.slice(0, 120)}`));

  if (vodUrls.length > 0) {
    const firstVodReq = allEntries.find(e => e.kind === 'request' && e.url.includes('bytevcloudapi.com'));
    if (firstVodReq) {
      console.log('\n=== FIRST VOD REQUEST (full) ===');
      console.log(JSON.stringify(firstVodReq, null, 2).slice(0, 3000));
    }
  }

  captureStream.end();
  await browser.close();
  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
