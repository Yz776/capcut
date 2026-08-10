// scripts/capture-editor-aggressive.js
//
// Final aggressive attempt to capture a real plane_draft/save call.
// Strategy: Open editor URL, wait MUCH longer (5+ min), intercept ALL XHR.
// Try multiple URL patterns and trigger save via Ctrl+S + Export.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const USER_DATA_DIR = process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');
const TEMPLATE_ID = process.argv[2] || '';
const OUT_FILE = path.join(projectRoot, 'tmp', 'aggressive-capture.jsonl');
const SAVE_DIR = path.join(projectRoot, 'tmp', 'aggressive-saves');
fs.mkdirSync(SAVE_DIR, { recursive: true });

const TARGET_ENDPOINTS = [
  'plane_draft/save',
  'plane_draft/get_draft_detail',
  'plane_draft/get_template_detail',
  'editor/draft/get_template_file',
  'editor/draft',
  'intelligence/render',
  'intelligence/fill',
  'render_task',
];

async function main() {
  console.log('=== Aggressive Editor Capture ===');
  console.log(`output: ${OUT_FILE}`);

  // Cleanup
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true }); } catch {}
  }
  try { require('child_process').execSync('pkill -9 -f chrome 2>/dev/null || true'); } catch {}

  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials', '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking', '--disable-sync',
      '--metrics-recording-only', '--mute-audio', '--no-default-browser-check',
      '--lang=en-US,en',
    ],
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 360000,
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const captureStream = fs.createWriteStream(OUT_FILE, { flags: 'w' });
  let saveCount = 0;

  page.on('request', (req) => {
    try {
      const url = req.url();
      const isTarget = TARGET_ENDPOINTS.some(e => url.includes(e));
      if (!isTarget) return;
      const postData = req.postData();
      const entry = { ts: Date.now(), method: req.method(), url, postDataLen: postData?.length || 0 };
      captureStream.write(JSON.stringify({ ...entry, kind: 'request', postData: postData?.slice(0, 50000) || null }) + '\n');
      console.log(`  → ${entry.method} ${url.slice(0, 110)} (body ${entry.postDataLen})`);

      if (url.includes('plane_draft/save') && postData) {
        saveCount++;
        const savePath = path.join(SAVE_DIR, `save-${saveCount}-${Date.now()}.json`);
        try {
          const body = JSON.parse(postData);
          fs.writeFileSync(savePath, JSON.stringify(body, null, 2));
          console.log(`  ✓✓✓ SAVED plane_draft/save body to ${savePath}`);
          if (body.template_data) {
            try {
              const td = JSON.parse(body.template_data);
              const tdPath = path.join(SAVE_DIR, `template-data-${saveCount}.json`);
              fs.writeFileSync(tdPath, JSON.stringify(td, null, 2));
              console.log(`  ✓ template_data parsed: keys=${Object.keys(td).join(', ')}`);
              if (td.materials?.videos?.[0]) {
                console.log(`    video material keys: ${Object.keys(td.materials.videos[0]).slice(0, 25).join(', ')}`);
              }
              if (td.tracks?.[0]?.segments?.[0]) {
                console.log(`    segment keys: ${Object.keys(td.tracks[0].segments[0]).slice(0, 25).join(', ')}`);
              }
            } catch (e) {
              fs.writeFileSync(savePath + '.raw', postData);
            }
          }
        } catch (e) {
          fs.writeFileSync(savePath + '.raw', postData);
        }
      }
    } catch (e) {}
  });

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const isTarget = TARGET_ENDPOINTS.some(e => url.includes(e));
      if (!isTarget) return;
      captureStream.write(JSON.stringify({ ts: Date.now(), kind: 'response_meta', url, status: res.status() }) + '\n');
      console.log(`  ← ${res.status()} ${url.slice(0, 110)}`);
    } catch (e) {}
  });

  // Try multiple URLs to find one that loads the editor
  const urls = [
    'https://www.capcut.com/editor',
    'https://www.capcut.com/editor?create_id=7598329412446375173',
    'https://www.capcut.com/editor-template?create_id=7598329412446375173',
  ];

  for (const editorUrl of urls) {
    console.log(`\n=== Trying: ${editorUrl} ===`);
    try {
      await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('✓ Navigation completed');
    } catch (e) {
      console.log(`Navigation warning: ${e.message.slice(0, 80)}`);
    }

    // Wait for editor load
    console.log('Waiting 90s for editor initial load...');
    await sleep(90000);
    console.log(`Current URL: ${page.url()}`);

    // Try Ctrl+S
    console.log('Trying Ctrl+S...');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Control');
    await sleep(20000);

    // Try to find and click Export button
    console.log('Looking for Export button...');
    const exportFound = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const exportBtn = buttons.find(b => b.textContent?.trim() === 'Export' && b.getBoundingClientRect().x > 100);
      if (exportBtn) {
        exportBtn.click();
        return { clicked: true, text: 'Export' };
      }
      return { clicked: false };
    }).catch(() => ({ clicked: false }));
    console.log('Export click:', JSON.stringify(exportFound));
    if (exportFound.clicked) {
      await sleep(30000);
      // Look for any confirmation dialog
      const dialogResult = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        // Look for Export button that's NOT in the toolbar (i.e. in a dialog)
        const candidates = buttons.filter(b => {
          const t = b.textContent?.trim();
          const r = b.getBoundingClientRect();
          return (t === 'Export' || t === 'OK' || t === 'Done' || t === 'Confirm' || t === 'Continue') && r.y > 50;
        });
        if (candidates.length > 0) {
          candidates[0].click();
          return { clicked: true, text: candidates[0].textContent?.trim() };
        }
        return { clicked: false };
      }).catch(() => ({ clicked: false }));
      console.log('Dialog click:', JSON.stringify(dialogResult));
      await sleep(30000);
    }

    // Wait more for autosave
    console.log('Final wait 60s...');
    await sleep(60000);

    if (saveCount > 0) {
      console.log(`\n✓✓✓ Captured ${saveCount} plane_draft/save calls!`);
      break;
    }
    console.log('No save captured yet, trying next URL...');
  }

  captureStream.end();
  await browser.close();

  if (saveCount > 0) {
    console.log(`\n=== ✓✓✓ SUCCESS — ${saveCount} plane_draft/save calls captured ===`);
    console.log(`Check ${SAVE_DIR} for save bodies.`);
    process.exit(0);
  } else {
    console.log('\n✗ No plane_draft/save call captured.');
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
