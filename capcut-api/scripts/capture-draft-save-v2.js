// scripts/capture-draft-save-v2.js
//
// V2: Simpler, more reliable — uses JS-level click + waits for navigation.
// Captures any plane_draft/save call (which contains the full draft content).
//
// Run: xvfb-run -a node scripts/capture-draft-save-v2.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const USER_DATA_DIR = process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');
const OUT_FILE = path.join(projectRoot, 'tmp', 'draft-save-capture-v2.jsonl');

const TARGET_ENDPOINTS = [
  'plane_draft/save',
  'plane_draft/get_draft_detail',
  'render_task/create',
  'render_task/batch_get',
  'get_template_file',
  'cc_web/plane/get_template_detail',
  'cc_web/replicate/multi_get_templates',
  'create_cloud_asset',
  'prepare_upload_cloud',
  'editor/draft',
];

async function main() {
  console.log('=== Draft Save Capture V2 ===');
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
    protocolTimeout: 180000,
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.bringToFront();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const captureStream = fs.createWriteStream(OUT_FILE, { flags: 'w' });
  const allEntries = [];

  // Set up request interception — capture everything to edit-api-sg.capcut.com + bytevcloudapi.com
  page.on('request', (req) => {
    try {
      const url = req.url();
      const isTarget = TARGET_ENDPOINTS.some(e => url.includes(e));
      const isVod = url.includes('bytevcloudapi.com') || url.includes('bytepluses.com') || url.includes('tos-');
      if (!isTarget && !isVod) return;
      const entry = {
        ts: Date.now(),
        kind: 'request',
        method: req.method(),
        url,
        postData: req.postData() || null,
        postDataLen: req.postData()?.length || 0,
      };
      allEntries.push(entry);
      // Log full postData for target endpoints, but truncate for VOD
      const logEntry = { ...entry };
      if (entry.postData && entry.postData.length > 12000) {
        logEntry.postData = entry.postData.slice(0, 12000) + '...[TRUNCATED]';
      }
      captureStream.write(JSON.stringify(logEntry) + '\n');
      console.log(`  → ${entry.method} ${url.slice(0, 100)} (body ${entry.postDataLen})`);
    } catch (e) {}
  });

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const isTarget = TARGET_ENDPOINTS.some(e => url.includes(e));
      const isVod = url.includes('bytevcloudapi.com') || url.includes('bytepluses.com') || url.includes('tos-');
      if (!isTarget && !isVod) return;
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
      console.log(`  ← ${res.status()} ${url.slice(0, 100)}`);
      try {
        const text = await res.text();
        captureStream.write(JSON.stringify({
          ts: Date.now(),
          kind: 'response_body',
          url,
          bodyLen: text.length,
          body: text.length > 12000 ? text.slice(0, 12000) + '...[TRUNCATED]' : text,
        }) + '\n');
      } catch {}
    } catch (e) {}
  });

  // === Step 1: Navigate to template page ===
  const templateUrl = 'https://www.capcut.com/t/7617043391162928401/';
  console.log(`Navigating to: ${templateUrl}`);
  try {
    await page.goto(templateUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.log(`Navigation warning: ${e.message.slice(0, 80)}`);
  }
  await sleep(20000);
  console.log('Page loaded.');

  // === Step 2: Click "Use this template" via JS-level DOM access ===
  console.log('\nClicking "Use this template" button via JS...');
  const clickResult = await page.evaluate(() => {
    // Try multiple strategies to find the button
    const strategies = [
      // Strategy 1: exact text match
      () => {
        const all = Array.from(document.querySelectorAll('a, button, [role="button"], div'));
        return all.find(el => {
          const t = el.textContent?.trim();
          return t && (t === 'Use this template' || t === 'Use template' || t === 'Try this template');
        });
      },
      // Strategy 2: text contains
      () => {
        const all = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        return all.find(el => {
          const t = el.textContent?.trim().toLowerCase();
          return t && t.includes('use') && t.includes('template');
        });
      },
      // Strategy 3: by class name
      () => {
        const els = document.querySelectorAll('[class*="use" i][class*="template" i], [class*="button-primary" i]');
        return els[0];
      },
      // Strategy 4: any link with href containing 'editor' or 'create'
      () => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        return links.find(a => /editor|create|template/.test(a.href) && a.textContent?.toLowerCase().includes('use'));
      },
    ];

    for (let i = 0; i < strategies.length; i++) {
      const el = strategies[i]();
      if (el) {
        const rect = el.getBoundingClientRect();
        const info = {
          found: true,
          strategy: i + 1,
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 50),
          href: el.href || '',
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        };
        // Click it
        el.click();
        return info;
      }
    }
    return { found: false };
  }).catch(e => ({ found: false, error: e.message }));
  console.log('Click result:', JSON.stringify(clickResult, null, 2));

  if (!clickResult.found) {
    console.log('✗ Could not find "Use this template" button');
  } else {
    console.log(`✓ Clicked "${clickResult.text}" via strategy ${clickResult.strategy}`);
    // Wait for navigation to editor
    console.log('Waiting for navigation to editor (max 60s)...');
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log(`✓ Navigated to: ${page.url()}`);
    } catch (e) {
      console.log(`waitForNavigation: ${e.message.slice(0, 80)} (continuing)`);
    }
  }

  // === Step 3: Wait for editor to load and auto-save ===
  console.log('\nWaiting 60s for editor to fully load + first auto-save...');
  await sleep(60000);
  try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'draft-v2-editor.png') }); } catch {}

  // Check if URL changed to editor-template
  const currentUrl = page.url();
  console.log(`Current URL: ${currentUrl}`);

  // Check for any plane_draft/save calls captured
  const saveCalls = allEntries.filter(e => e.url?.includes('plane_draft/save'));
  console.log(`\nplane_draft/save calls so far: ${saveCalls.length}`);

  // If no save call yet, look for an Export button and click it to trigger save
  if (saveCalls.length === 0) {
    console.log('\nLooking for Export/Save button in editor...');
    const exportResult = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const candidates = all.filter(el => {
        const t = el.textContent?.trim().toLowerCase();
        if (!t || t.length > 30) return false;
        return t === 'export' || t === 'save' || t.includes('export') || t.includes('save draft') || t === '完成' || t === '导出';
      });
      if (candidates.length === 0) return { found: false, candidates: [] };
      const target = candidates[0];
      const rect = target.getBoundingClientRect();
      target.click();
      return {
        found: true,
        text: target.textContent?.trim().slice(0, 50),
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      };
    }).catch(e => ({ found: false, error: e.message }));
    console.log('Export click result:', JSON.stringify(exportResult, null, 2));
    if (exportResult.found) {
      console.log('Waiting 30s after export click...');
      await sleep(30000);
      try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'draft-v2-after-export.png') }); } catch {}
    }
  }

  // === Step 4: Final wait and summary ===
  console.log('\nFinal 20s wait...');
  await sleep(20000);

  const finalSaveCalls = allEntries.filter(e => e.url?.includes('plane_draft/save'));
  const finalRenderCalls = allEntries.filter(e => e.url?.includes('render_task/create'));
  const finalTemplateCalls = allEntries.filter(e => e.url?.includes('get_template'));
  console.log(`\n=== Final summary ===`);
  console.log(`Total entries: ${allEntries.length}`);
  console.log(`plane_draft/save: ${finalSaveCalls.length}`);
  console.log(`render_task/create: ${finalRenderCalls.length}`);
  console.log(`get_template*: ${finalTemplateCalls.length}`);

  if (finalSaveCalls.length > 0) {
    console.log('\n=== ✓✓✓ plane_draft/save CAPTURED ===');
    console.log(`Body length: ${finalSaveCalls[0].postDataLen}`);
  }

  captureStream.end();
  await browser.close();
  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
