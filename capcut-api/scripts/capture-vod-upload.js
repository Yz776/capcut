// scripts/capture-vod-upload.js
//
// Capture the actual VOD/ImageX upload flow by puppeteer-launching the
// CapCut editor, then programmatically triggering an asset upload via
// the editor's UI.
//
// What this captures:
//   1. The editor's call to /lv/v1/asset/prepare_upload_cloud (already known)
//   2. The editor's call to https://vod-ap-singapore-1.bytevcloudapi.com/
//      with the EXACT signing algorithm used by CapCut's web SDK
//   3. The actual file upload to https://tos-*.bytepluses.com/...
//   4. The editor's call to /lv/v1/asset/create_cloud_asset (already known)
//
// We just need step 2-3 to understand the signing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const USER_DATA_DIR = process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');
const OUT_FILE = path.join(projectRoot, 'tmp', 'vod-upload-capture.jsonl');
const TEST_IMAGE = path.join(projectRoot, 'test-assets', 'img1.jpg');

const INTERCEPT_DOMAINS = [
  'bytevcloudapi.com',
  'vodupload.com',
  'bytepluses.com',
  'ibytedtos.com',
  'ibyteimg.com',
  'edit-api-sg.capcut.com',
];

function shouldCapture(url) {
  return INTERCEPT_DOMAINS.some(d => url.includes(d));
}

async function main() {
  console.log('=== VOD Upload Network Capture ===');
  console.log(`userDataDir: ${USER_DATA_DIR}`);
  console.log(`output: ${OUT_FILE}\n`);

  // Cleanup stale locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true }); } catch {}
  }

  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: false,  // need visible browser to interact with editor
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--start-maximized',
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const captureStream = fs.createWriteStream(OUT_FILE, { flags: 'w' });

  // === Set up request/response interception (NOT blocking) ===
  const captured = [];
  page.on('request', (req) => {
    try {
      const url = req.url();
      if (!shouldCapture(url)) return;
      const headers = req.headers();
      const postData = req.postData();
      const entry = {
        ts: Date.now(),
        kind: 'request',
        method: req.method(),
        url,
        headers: JSON.stringify(headers).slice(0, 4000),
        postData: postData ? postData.slice(0, 8000) : null,
      };
      captured.push(entry);
      captureStream.write(JSON.stringify(entry) + '\n');
    } catch (e) {}
  });

  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!shouldCapture(url)) return;
      const req = res.request();
      const meta = {
        ts: Date.now(),
        kind: 'response_meta',
        method: req.method(),
        url,
        status: res.status(),
        contentType: res.headers()['content-type'] || '',
        headers: JSON.stringify(res.headers()).slice(0, 4000),
      };
      captured.push(meta);
      captureStream.write(JSON.stringify(meta) + '\n');

      // Capture response bodies for bytevcloudapi calls
      if (url.includes('bytevcloudapi.com') || url.includes('prepare_upload_cloud') || url.includes('create_cloud_asset')) {
        try {
          const text = await res.text();
          captureStream.write(JSON.stringify({
            ts: Date.now(),
            kind: 'response_body',
            url,
            body: text.slice(0, 8000),
          }) + '\n');
        } catch {}
      }
    } catch (e) {}
  });

  // === Navigate to CapCut editor template page ===
  // Pick a simple editable template — the same one used in our previous captures
  const templateId = '7617043391162928401';  // editable template
  const templateUrl = `https://www.capcut.com/editor-template?create_id=${templateId}`;
  console.log(`Navigating to: ${templateUrl}\n`);

  try {
    await page.goto(templateUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log(`Navigation warning: ${e.message}`);
  }

  console.log('Waiting 30s for editor to fully load...');
  await sleep(30000);

  // Take a screenshot to see what we have
  await page.screenshot({ path: path.join(projectRoot, 'tmp', 'vod-capture-editor-loaded.png') });
  console.log('Screenshot saved: tmp/vod-capture-editor-loaded.png');

  // Try to find an "Upload" button or tab in the editor UI
  console.log('\nLooking for upload UI elements...');
  const uploadElements = await page.evaluate(() => {
    const all = document.querySelectorAll('button, [role="tab"], [role="button"], div[class*="upload" i], div[class*="Upload"]');
    return Array.from(all).slice(0, 30).map(el => ({
      tag: el.tagName,
      text: el.textContent?.slice(0, 60),
      class: el.className?.slice(0, 100),
      id: el.id,
    }));
  }).catch(() => []);
  console.log('Upload candidates:', JSON.stringify(uploadElements, null, 2));

  // Try to find the file input element that CapCut uses for uploads
  console.log('\nLooking for hidden file inputs...');
  const fileInputs = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="file"]');
    return Array.from(inputs).map(el => ({
      accept: el.accept,
      multiple: el.multiple,
      name: el.name,
      id: el.id,
      class: el.className?.slice(0, 80),
      visible: el.offsetParent !== null,
    }));
  }).catch(() => []);
  console.log('File inputs:', JSON.stringify(fileInputs, null, 2));

  // If there's a file input, try uploading our test image
  if (fileInputs.length > 0) {
    console.log(`\nFound ${fileInputs.length} file input(s). Attempting upload via first one...`);
    try {
      const input = await page.$('input[type="file"]');
      if (input) {
        await input.uploadFile(TEST_IMAGE);
        console.log('✓ File uploaded to input. Waiting 60s for upload to complete...');
        await sleep(60000);
        await page.screenshot({ path: path.join(projectRoot, 'tmp', 'vod-capture-after-upload.png') });
        console.log('After-upload screenshot saved.');
      }
    } catch (e) {
      console.log(`Upload attempt failed: ${e.message}`);
    }
  } else {
    // Try clicking the upload tab/button first
    console.log('\nNo file inputs found. Trying to click "Upload" button...');
    try {
      const clicked = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div'));
        const uploadEl = all.find(el => {
          const t = el.textContent?.trim().toLowerCase();
          return t === 'upload' || t === 'uploads' || el.className?.toLowerCase().includes('upload');
        });
        if (uploadEl) {
          uploadEl.click();
          return { clicked: true, text: uploadEl.textContent?.slice(0, 60), tag: uploadEl.tagName };
        }
        return { clicked: false };
      });
      console.log('Click result:', clicked);
      if (clicked.clicked) {
        await sleep(3000);
        // Re-check for file inputs after clicking upload
        const newInputs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input[type="file"]')).map(el => ({
            accept: el.accept, multiple: el.multiple, class: el.className?.slice(0, 80)
          }))
        ).catch(() => []);
        console.log('File inputs after click:', JSON.stringify(newInputs, null, 2));
        if (newInputs.length > 0) {
          const input = await page.$('input[type="file"]');
          if (input) {
            await input.uploadFile(TEST_IMAGE);
            console.log('✓ File uploaded. Waiting 60s...');
            await sleep(60000);
          }
        }
      }
    } catch (e) {
      console.log(`Click attempt failed: ${e.message}`);
    }
  }

  // Save a summary
  console.log(`\n=== Capture summary ===`);
  console.log(`Total entries: ${captured.length}`);
  const vodCalls = captured.filter(e => e.url?.includes('bytevcloudapi.com'));
  console.log(`bytevcloudapi.com calls: ${vodCalls.length}`);
  if (vodCalls.length > 0) {
    console.log('\nFirst VOD request:');
    console.log(JSON.stringify(vodCalls[0], null, 2).slice(0, 2000));
  }

  captureStream.end();
  await browser.close();
  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
