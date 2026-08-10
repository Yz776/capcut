// scripts/capture-draft-save.js
//
// Capture the plane_draft/save call (full draft content) that the editor
// makes when a user opens a template and starts editing.
//
// Strategy:
//   1. Open a CapCut template detail page (not editor-template)
//   2. Click "Use template" / "Edit template" button
//   3. Wait for editor to load with template content
//   4. Wait for editor's first auto-save or manually trigger save
//   5. Capture the plane_draft/save POST body (full draft content JSON)
//
// Run: xvfb-run -a node scripts/capture-draft-save.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const USER_DATA_DIR = process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');
const OUT_FILE = path.join(projectRoot, 'tmp', 'draft-save-capture.jsonl');

// Only capture POST bodies for these endpoints
const CAPTURE_BODY_ENDPOINTS = [
  'plane_draft/save',
  'plane_draft/get_draft_detail',
  'render_task/create',
  'render_task/batch_get',
  'get_template_file',
  'cc_web/plane/get_template_detail',
  'cc_web/replicate/multi_get_templates',
  'create_cloud_asset',
  'prepare_upload_cloud',
];

async function main() {
  console.log('=== Draft Save Capture ===');
  console.log(`output: ${OUT_FILE}\n`);

  // Cleanup stale locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true }); } catch {}
  }

  // Kill any stale chrome processes
  try { 
    const { execSync } = await import('node:child_process');
    execSync('pkill -9 -f chrome 2>/dev/null || true');
    await sleep(2000);
  } catch {}

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
      '--disable-features=site-per-process',
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

  page.on('request', (req) => {
    try {
      const url = req.url();
      const isTarget = CAPTURE_BODY_ENDPOINTS.some(e => url.includes(e));
      if (!isTarget && !url.includes('edit-api-sg.capcut.com')) return;
      const entry = {
        ts: Date.now(),
        kind: 'request',
        method: req.method(),
        url,
        headers: req.headers(),
        postData: req.postData() ? req.postData() : null,
      };
      allEntries.push(entry);
      const logEntry = { ...entry, headers: JSON.stringify(entry.headers).slice(0, 6000) };
      captureStream.write(JSON.stringify(logEntry) + '\n');
      if (isTarget) {
        console.log(`  → ${entry.method} ${url.slice(0, 100)}`);
        if (entry.postData && entry.postData.length < 5000) {
          console.log(`    body: ${entry.postData.slice(0, 500)}`);
        } else if (entry.postData) {
          console.log(`    body length: ${entry.postData.length}`);
        }
      }
    } catch (e) {}
  });

  page.on('response', async (res) => {
    try {
      const url = res.url();
      const isTarget = CAPTURE_BODY_ENDPOINTS.some(e => url.includes(e));
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
      console.log(`  ← ${res.status()} ${url.slice(0, 100)}`);

      // Capture response bodies for target endpoints
      try {
        const text = await res.text();
        const bodyEntry = {
          ts: Date.now(),
          kind: 'response_body',
          url,
          body: text,
        };
        captureStream.write(JSON.stringify(bodyEntry) + '\n');
        if (text.length < 2000) console.log(`    resp: ${text.slice(0, 800)}`);
      } catch {}
    } catch (e) {}
  });

  // === Step 1: Navigate to a template detail page (NOT editor-template) ===
  // Try template ID 7617043391162928401 — this was used in our previous capture
  // First try the public template detail page
  const templateUrls = [
    'https://www.capcut.com/t/7617043391162928401/',
    'https://www.capcut.com/editor-template?create_id=7617043391162928401',
    'https://www.capcut.com/t/7582506944926289157/',
    'https://www.capcut.com/editor-template?create_id=7582506944926289157',
  ];

  let navigated = false;
  for (const url of templateUrls) {
    console.log(`\nTrying: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      navigated = true;
      console.log('✓ Navigation succeeded');
      break;
    } catch (e) {
      console.log(`✗ Navigation failed: ${e.message.slice(0, 80)}`);
    }
  }

  if (!navigated) {
    console.log('✗ Could not navigate to any template URL');
    await browser.close();
    process.exit(1);
  }

  console.log('\nWaiting 30s for page to load...');
  await sleep(30000);
  try { await page.screenshot({ path: path.join(projectRoot, 'tmp', 'draft-capture-page.png') }); } catch {}

  // Look for "Use template" / "Edit template" button
  console.log('\nSearching for "Use template" / "Edit" buttons...');
  const useTemplateBtn = await page.evaluate(() => {
    const result = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node;
    const matchers = [
      'use template', 'use this template', 'edit template', 'try this template',
      'try template', 'create', 'edit', 'use', 'try', 'open in editor',
      'start editing', 'start now', 'get started', 'open editor',
    ];
    while (node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (!text || text.length > 60) continue;
      const lower = text.toLowerCase();
      // Match if any matcher is contained in text OR text equals matcher
      const isMatch = matchers.some(m => lower === m || lower.includes(m));
      if (!isMatch) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 30 && rect.height > 15) {
        result.push({
          tag: node.tagName,
          text,
          class: node.className?.toString().slice(0, 80),
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          clickable: node.onclick != null || node.tagName === 'BUTTON' || node.tagName === 'A' || node.getAttribute('role') === 'button',
        });
      }
    }
    // Dedupe by position
    const seen = new Set();
    return result.filter(r => {
      const key = `${Math.floor(r.rect.x)}_${Math.floor(r.rect.y)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 15);
  }).catch(() => []);
  console.log('Use-template candidates:', JSON.stringify(useTemplateBtn, null, 2));

  // Click the most promising button — prefer "use this template" / "use template"
  const sortedCandidates = [...useTemplateBtn].sort((a, b) => {
    const aScore = a.text.toLowerCase().includes('use') ? 0 : 1;
    const bScore = b.text.toLowerCase().includes('use') ? 0 : 1;
    return aScore - bScore;
  });
  console.log('\nSorted candidates (use* first):', sortedCandidates.map(c => c.text).slice(0, 5));

  for (const candidate of sortedCandidates.slice(0, 3)) {
    try {
      console.log(`\nClicking "${candidate.text}" (${candidate.tag})...`);
      await page.mouse.click(candidate.rect.x + candidate.rect.w / 2, candidate.rect.y + candidate.rect.h / 2);
      console.log('  clicked, waiting 30s for editor to load + auto-save...');
      await sleep(30000);
      try { await page.screenshot({ path: path.join(projectRoot, 'tmp', `draft-after-click-${Date.now()}.png`) }); } catch {}

      // Check if we have a plane_draft/save call yet
      const hasSaveCall = allEntries.some(e => e.url?.includes('plane_draft/save'));
      if (hasSaveCall) {
        console.log('✓✓✓ plane_draft/save captured! Waiting 30s more for any render calls...');
        await sleep(30000);
        break;
      } else {
        console.log('  no plane_draft/save yet. Trying to find export/save button...');
        // Look for export button in the editor
        const exportBtn = await page.evaluate(() => {
          const result = [];
          document.querySelectorAll('button, [role="button"]').forEach(el => {
            const t = el.textContent?.trim().toLowerCase();
            if ((t === 'export' || t === 'save' || t.includes('export') || t.includes('save draft')) && t.length < 30) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                result.push({ text: el.textContent?.trim().slice(0, 50), rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
              }
            }
          });
          return result.slice(0, 5);
        }).catch(() => []);
        console.log('  Export/Save candidates:', JSON.stringify(exportBtn, null, 2));
        if (exportBtn.length > 0) {
          console.log('  Clicking export button...');
          await page.mouse.click(exportBtn[0].rect.x + exportBtn[0].rect.w / 2, exportBtn[0].rect.y + exportBtn[0].rect.h / 2);
          await sleep(20000);
        }
      }
    } catch (e) {
      console.log(`  click failed: ${e.message}`);
    }
  }

  // Final wait for any in-flight requests
  console.log('\nWaiting 20s for any final requests...');
  await sleep(20000);

  // Summary
  console.log(`\n=== Capture summary ===`);
  console.log(`Total entries: ${allEntries.length}`);
  const saveCalls = allEntries.filter(e => e.url?.includes('plane_draft/save'));
  const renderCalls = allEntries.filter(e => e.url?.includes('render_task/create'));
  const templateCalls = allEntries.filter(e => e.url?.includes('get_template'));
  console.log(`plane_draft/save calls: ${saveCalls.length}`);
  console.log(`render_task/create calls: ${renderCalls.length}`);
  console.log(`get_template calls: ${templateCalls.length}`);

  if (saveCalls.length > 0) {
    console.log('\n=== ✓ plane_draft/save CAPTURED ===');
    console.log(`URL: ${saveCalls[0].url}`);
    console.log(`Body length: ${saveCalls[0].postData?.length || 0}`);
    console.log(`Body preview: ${saveCalls[0].postData?.slice(0, 500) || '(empty)'}`);
  }

  captureStream.end();
  await browser.close();
  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
