// scripts/capture-empty-editor-draft.js
//
// Open the CapCut editor at https://www.capcut.com/editor (NO template).
// This loads an empty editor which should auto-save a minimal draft.
// If that fails, we click "Export" to force a save.
//
// Run: xvfb-run -a node scripts/capture-empty-editor-draft.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const USER_DATA_DIR = process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');
const OUT_FILE = path.join(projectRoot, 'tmp', 'empty-editor-capture.jsonl');
const SAVE_DIR = path.join(projectRoot, 'tmp', 'empty-editor-saves');
fs.mkdirSync(SAVE_DIR, { recursive: true });

const TARGET_ENDPOINTS = [
  'plane_draft/save',
  'plane_draft/get_draft_detail',
  'plane_draft/get_template_detail',
  'render_task/create',
  'render_task/batch_get',
  'editor/draft/get_template_file',
  'cc_web/plane/get_template_detail',
  'cc_web/replicate/multi_get_templates',
  'create_cloud_asset',
  'prepare_upload_cloud',
  'upload_sign',
  'editor/draft',
  'intelligence/render',
  'intelligence/fill',
  'vod/upload',
  'get_user_draft',
  'apply_upload',
  'commit_upload',
];

async function main() {
  console.log('=== Empty Editor Draft Capture ===');
  console.log(`output: ${OUT_FILE}\n`);

  // Cleanup stale locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true }); } catch {}
  }
  try { require('child_process').execSync('pkill -9 -f "chrome.*capcut-profile" 2>/dev/null || true'); } catch {}

  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-default-browser-check',
      '--lang=en-US,en',
      '--auto-select-desktop-capture-source=CapCut',
    ],
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 300000,
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.bringToFront();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const captureStream = fs.createWriteStream(OUT_FILE, { flags: 'w' });
  const allEntries = [];
  let saveCount = 0;
  let detailCount = 0;

  // === Set up request/response interception ===
  page.on('request', (req) => {
    try {
      const url = req.url();
      const isTarget = TARGET_ENDPOINTS.some(e => url.includes(e));
      if (!isTarget) return;
      const entry = {
        ts: Date.now(),
        kind: 'request',
        method: req.method(),
        url,
        postData: req.postData() || null,
        postDataLen: req.postData()?.length || 0,
      };
      allEntries.push(entry);
      captureStream.write(JSON.stringify(entry) + '\n');
      console.log(`  → ${entry.method} ${url.slice(0, 110)} (body ${entry.postDataLen})`);

      // Save plane_draft/save body
      if (url.includes('plane_draft/save') && entry.postData) {
        saveCount++;
        const savePath = path.join(SAVE_DIR, `save-${saveCount}-${Date.now()}.json`);
        try {
          const body = JSON.parse(entry.postData);
          fs.writeFileSync(savePath, JSON.stringify(body, null, 2));
          console.log(`  ✓✓✓ SAVED plane_draft/save body to ${savePath}`);
          if (body.template_data) {
            try {
              const td = JSON.parse(body.template_data);
              const tdPath = path.join(SAVE_DIR, `template-data-${saveCount}.json`);
              fs.writeFileSync(tdPath, JSON.stringify(td, null, 2));
              console.log(`  ✓ template_data parsed and saved to ${tdPath}`);
              console.log(`    keys: ${Object.keys(td).join(', ')}`);
              if (td.materials) console.log(`    materials keys: ${Object.keys(td.materials).join(', ')}`);
              if (td.tracks) console.log(`    tracks count: ${td.tracks.length}`);
              if (td.duration) console.log(`    duration: ${td.duration}`);
            } catch (e) {
              console.log(`  ! template_data not JSON: ${e.message}`);
            }
          }
        } catch (e) {
          fs.writeFileSync(savePath + '.raw', entry.postData);
        }
      }

      // Save plane_draft/get_draft_detail request body
      if (url.includes('get_draft_detail') && entry.postData) {
        detailCount++;
        const savePath = path.join(SAVE_DIR, `get-detail-req-${detailCount}.json`);
        fs.writeFileSync(savePath, entry.postData);
      }
    } catch (e) {}
  });

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const isTarget = TARGET_ENDPOINTS.some(e => url.includes(e));
      if (!isTarget) return;
      const req = res.request();
      const meta = {
        ts: Date.now(),
        kind: 'response_meta',
        method: req.method(),
        url,
        status: res.status(),
      };
      allEntries.push(meta);
      captureStream.write(JSON.stringify(meta) + '\n');
      console.log(`  ← ${res.status()} ${url.slice(0, 110)}`);
      try {
        const text = await res.text();
        captureStream.write(JSON.stringify({
          ts: Date.now(),
          kind: 'response_body',
          url,
          bodyLen: text.length,
          body: text.length > 50000 ? text.slice(0, 50000) + '...[TRUNCATED]' : text,
        }) + '\n');
        // For get_draft_detail responses, save full body
        if (url.includes('get_draft_detail')) {
          const savePath = path.join(SAVE_DIR, `get-detail-resp-${Date.now()}.json`);
          fs.writeFileSync(savePath, text.length > 200000 ? text.slice(0, 200000) : text);
          console.log(`  ✓ saved draft detail response to ${savePath}`);
        }
      } catch {}
    } catch (e) {}
  });

  // === Navigate to empty editor ===
  const editorUrl = 'https://www.capcut.com/editor';
  console.log(`\n=== Navigating to: ${editorUrl} ===`);
  try {
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('✓ Navigation completed');
  } catch (e) {
    console.log(`Navigation warning: ${e.message.slice(0, 100)}`);
  }

  // Wait for editor to load
  console.log('\nWaiting 60s for editor initial load (and any autosave)...');
  await sleep(60000);
  console.log(`Current URL: ${page.url()}`);
  try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'empty-editor-initial.png') }); } catch {}

  // Check what we've captured so far
  const saveCallsSoFar = allEntries.filter(e => e.url?.includes('plane_draft/save'));
  console.log(`\nplane_draft/save calls so far: ${saveCallsSoFar.length}`);

  // Try keyboard shortcut Ctrl+S to trigger save
  console.log('\nTrying Ctrl+S to trigger save...');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
  await sleep(10000);

  // Look for any buttons that might trigger save
  const allButtons = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], a'));
    return els.filter(el => {
      const t = el.textContent?.trim().toLowerCase();
      if (!t || t.length > 40) return false;
      return /export|save|draft|upload|添加|导出|保存|上传/.test(t);
    }).slice(0, 30).map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim().slice(0, 40),
      rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    }));
  }).catch(() => []);
  console.log(`Found ${allButtons.length} candidate buttons:`);
  allButtons.forEach((b, i) => {
    console.log(`  [${i}] <${b.tag}> "${b.text}" at (${b.rect.x},${b.rect.y}) ${b.rect.w}x${b.rect.h}`);
  });

  // Wait more for autosave
  console.log('\nWaiting 60s more for any autosave...');
  await sleep(60000);

  // === Final summary ===
  const finalSaveCalls = allEntries.filter(e => e.url?.includes('plane_draft/save'));
  console.log(`\n=== Final summary ===`);
  console.log(`Total entries: ${allEntries.length}`);
  console.log(`plane_draft/save: ${finalSaveCalls.length}`);

  captureStream.end();
  await browser.close();

  if (finalSaveCalls.length > 0) {
    console.log('\n✓✓✓ At least one plane_draft/save call was captured!');
    console.log(`Check ${SAVE_DIR} for save body files.`);
    process.exit(0);
  } else {
    console.log('\n✗ No plane_draft/save call captured.');
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
