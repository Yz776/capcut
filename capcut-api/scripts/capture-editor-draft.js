// scripts/capture-editor-draft.js
//
// Open the CapCut editor directly with a template ID, intercept plane_draft/save
// calls to capture a real draft JSON structure we can use as a template.
//
// Run: xvfb-run -a node scripts/capture-editor-draft.js [template_id]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const USER_DATA_DIR = process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');
const TEMPLATE_ID = process.argv[2] || '7598329412446375173';
const OUT_FILE = path.join(projectRoot, 'tmp', 'editor-draft-capture.jsonl');
const SAVE_DIR = path.join(projectRoot, 'tmp', 'editor-draft-saves');
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
];

async function main() {
  console.log('=== Editor Draft Capture ===');
  console.log(`template_id: ${TEMPLATE_ID}`);
  console.log(`output: ${OUT_FILE}\n`);

  // Cleanup stale locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true }); } catch {}
  }
  // Kill any chrome processes that might hold the lock
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
    ],
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 240000,
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.bringToFront();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const captureStream = fs.createWriteStream(OUT_FILE, { flags: 'w' });
  const allEntries = [];
  let saveCount = 0;

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

      // If this is a plane_draft/save call, save the body separately
      if (url.includes('plane_draft/save') && entry.postData) {
        saveCount++;
        const savePath = path.join(SAVE_DIR, `save-${saveCount}-${Date.now()}.json`);
        try {
          const body = JSON.parse(entry.postData);
          fs.writeFileSync(savePath, JSON.stringify(body, null, 2));
          console.log(`  ✓✓✓ SAVED plane_draft/save body to ${savePath}`);
          // Also save template_data as separate JSON for easier inspection
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
          console.log(`  ! Could not parse save body as JSON, saved raw to ${savePath}.raw`);
        }
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
          body: text.length > 12000 ? text.slice(0, 12000) + '...[TRUNCATED]' : text,
        }) + '\n');
        // For template_detail responses, save full body
        if (url.includes('get_template_detail') || url.includes('get_template_file')) {
          const savePath = path.join(SAVE_DIR, `response-${url.split('/').pop().split('?')[0]}-${Date.now()}.json`);
          fs.writeFileSync(savePath, text.length > 200000 ? text.slice(0, 200000) : text);
          console.log(`  ✓ saved response body to ${savePath}`);
        }
      } catch {}
    } catch (e) {}
  });

  // === Navigate to editor URL directly ===
  const editorUrl = `https://www.capcut.com/editor-template?create_id=${TEMPLATE_ID}`;
  console.log(`\n=== Navigating to editor: ${editorUrl} ===`);
  try {
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('✓ Navigation completed');
  } catch (e) {
    console.log(`Navigation warning: ${e.message.slice(0, 100)}`);
  }

  // Wait for editor to load
  console.log('\nWaiting 30s for editor initial load...');
  await sleep(30000);
  console.log(`Current URL: ${page.url()}`);
  try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'editor-initial.png') }); } catch {}

  // Check what we've captured so far
  const saveCallsSoFar = allEntries.filter(e => e.url?.includes('plane_draft/save'));
  console.log(`\nplane_draft/save calls so far: ${saveCallsSoFar.length}`);

  // Try to find template_detail/get calls
  const templateCalls = allEntries.filter(e => e.url?.includes('get_template_detail') || e.url?.includes('get_template_file'));
  console.log(`template detail/file calls: ${templateCalls.length}`);

  // Look for "Use template" / "Try this template" button on the page (in case redirected to template page)
  console.log('\nLooking for buttons to click...');
  const buttonInfo = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const candidates = all.filter(el => {
      const t = el.textContent?.trim().toLowerCase();
      if (!t || t.length > 60) return false;
      return /use|template|try|export|save|edit|开始|使用|模板/.test(t);
    }).slice(0, 20);
    return candidates.map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim().slice(0, 60),
      href: el.href || '',
      rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
    }));
  }).catch(e => []);
  console.log(`Found ${buttonInfo.length} candidate buttons:`);
  buttonInfo.forEach((b, i) => {
    console.log(`  [${i}] <${b.tag}> "${b.text}" href="${b.href?.slice(0, 80)}" at (${b.rect.x},${b.rect.y}) ${b.rect.w}x${b.rect.h}`);
  });

  // Click "Export" button (we saw it's at top-right of editor)
  // This triggers plane_draft/save before render.
  if (saveCallsSoFar.length === 0) {
    const exportBtn = buttonInfo.find(b => /^Export$/i.test(b.text.trim()) && b.rect.x > 100);
    if (exportBtn) {
      console.log(`\nClicking Export button at (${exportBtn.rect.x},${exportBtn.rect.y})`);
      const clickResult = await page.evaluate((info) => {
        const els = Array.from(document.querySelectorAll('button'));
        const el = els.find(e => e.textContent?.trim() === 'Export' && e.getBoundingClientRect().x > 100);
        if (el) {
          el.click();
          return { clicked: true, text: el.textContent?.trim() };
        }
        return { clicked: false };
      }, exportBtn).catch(e => ({ clicked: false, error: e.message }));
      console.log('Click result:', JSON.stringify(clickResult));
      console.log('Waiting 30s after Export click for save+render calls...');
      await sleep(30000);
      try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'editor-after-export.png') }); } catch {}

      // Check what we've captured
      const newSaveCalls = allEntries.filter(e => e.url?.includes('plane_draft/save'));
      const newRenderCalls = allEntries.filter(e => e.url?.includes('render_task'));
      console.log(`After Export: plane_draft/save=${newSaveCalls.length} render_task=${newRenderCalls.length}`);

      // Look for any dialog/modal that might appear after Export (e.g. resolution picker)
      const dialogButtons = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, [role="button"]'));
        return all.filter(el => {
          const t = el.textContent?.trim().toLowerCase();
          if (!t || t.length > 30) return false;
          return /export|done|confirm|ok|continue|next|开始|导出|确定/.test(t);
        }).slice(0, 10).map(el => ({
          text: el.textContent?.trim().slice(0, 30),
          rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
        }));
      }).catch(() => []);
      console.log(`Dialog buttons after Export:`, JSON.stringify(dialogButtons, null, 2));
      // Click any "Export"/"Done"/"Confirm" button that's NOT the original top-right one
      for (const b of dialogButtons) {
        if (b.text === 'Export' && b.rect.y > 50) {
          console.log(`Clicking dialog button: "${b.text}"`);
          await page.evaluate((info) => {
            const els = Array.from(document.querySelectorAll('button, [role="button"]'));
            const el = els.find(e => e.textContent?.trim() === info.text && e.getBoundingClientRect().y > 50);
            if (el) el.click();
          }, b).catch(() => {});
          await sleep(20000);
          break;
        }
      }
    } else {
      console.log('✗ No Export button found at top-right');
    }
  }

  // === Final wait for autosave ===
  console.log('\nWaiting 60s more for autosave...');
  await sleep(60000);
  try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'editor-final.png') }); } catch {}

  // === Summary ===
  const finalSaveCalls = allEntries.filter(e => e.url?.includes('plane_draft/save'));
  const finalTemplateCalls = allEntries.filter(e => e.url?.includes('get_template_detail') || e.url?.includes('get_template_file'));
  console.log(`\n=== Final summary ===`);
  console.log(`Total entries: ${allEntries.length}`);
  console.log(`plane_draft/save: ${finalSaveCalls.length}`);
  console.log(`template detail/file: ${finalTemplateCalls.length}`);

  captureStream.end();
  await browser.close();
  console.log('\n=== Done ===');
  if (finalSaveCalls.length > 0) {
    console.log('✓✓✓ At least one plane_draft/save call was captured!');
    console.log(`Check ${SAVE_DIR} for save body files.`);
    process.exit(0);
  } else {
    console.log('✗ No plane_draft/save call captured.');
    console.log('Check tmp/editor-draft-saves/ for any template detail responses.');
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
