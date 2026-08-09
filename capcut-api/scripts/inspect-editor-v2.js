// scripts/inspect-editor-v2.js
// Investigasi lebih dalam: setelah upload, cek:
//  - Media panel structure (di mana image muncul)
//  - Timeline slot placeholder (di mana image harus ditaruh)
//  - CapCut internal API calls (network request) untuk "use template" atau "apply"
//
// Usage:
//   node scripts/inspect-editor-v2.js <templateId> <img1> [img2]

import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = process.env.CAPCUT_USER_DATA_DIR || path.resolve(projectRoot, '.capcut-profile');
const tmpDir = path.resolve(projectRoot, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const BASE_URL = process.env.CAPCUT_BASE_URL || 'https://www.capcut.com';
const templateId = process.argv[2] || '7598329412446375173';
const imagePaths = process.argv.slice(3).filter(p => !p.startsWith('-'));

if (imagePaths.length < 1) {
  console.error('Usage: node scripts/inspect-editor-v2.js <templateId> <imgPath1> [imgPath2]...');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n=== CapCut Editor Inspector v2 ===`);
  console.log(`templateId : ${templateId}`);
  console.log(`images     : ${imagePaths.join(', ')}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
      '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle',
      '--mute-audio',
    ],
  });

  // ===== Network listener: capture CapCut internal API calls =====
  const apiCalls = [];
  try {
    const page0 = (await browser.pages())[0] || await browser.newPage();
    page0.on('response', async (resp) => {
      const url = resp.url();
      if (!/capcut\.com|bytedance|ibyteimg|capcutvod/.test(url)) return;
      if (/\.(js|css|png|jpg|webp|woff|svg|ico)(\?|$)/.test(url)) return;
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('text') && !ct.includes('javascript')) return;
        const status = resp.status();
        let body = '';
        if (ct.includes('json')) {
          try { body = await resp.text(); } catch (_) {}
        }
        apiCalls.push({ method: resp.request().method(), url: url.slice(0, 250), status, ct, bodyLen: body.length, bodyPreview: body.slice(0, 300) });
      } catch (_) {}
    });
  } catch (_) {}

  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.setDefaultTimeout(60000);

    // Step 1: Buka editor
    console.log(`\n[1] Opening editor: ${BASE_URL}/editor-template?create_id=${templateId}`);
    await page.goto(`${BASE_URL}/editor-template?create_id=${templateId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(20000); // tunggu SPA load

    // Tutup modals
    for (let i = 0; i < 5; i++) {
      try {
        const close = await page.$('.lv-modal-close-icon, [class*="modal-close" i]');
        if (close) { await close.click(); await sleep(400); continue; }
      } catch (_) {}
      try { await page.keyboard.press('Escape'); await sleep(300); } catch (_) {}
      const stillVisible = await page.evaluate(() => {
        const m = document.querySelector('.lv-modal-mask, .lv-modal-wrapper');
        return m && m.offsetParent !== null;
      });
      if (!stillVisible) break;
    }

    // Step 2: Upload images
    console.log('[2] Uploading images...');
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      console.error('   file input tidak ketemu');
      process.exit(1);
    }
    await fileInput.uploadFile(...imagePaths.map(p => path.resolve(p)));
    await sleep(15000);
    await page.screenshot({ path: path.join(tmpDir, 'v2-1-after-upload.png'), fullPage: false });
    console.log('   screenshot: tmp/v2-1-after-upload.png');

    // Step 3: Dump media panel & timeline structure
    console.log('[3] Dumping editor DOM structure...');

    const editorInfo = await page.evaluate(() => {
      const result = {};

      // Cari elemen dengan class mengandung "media", "asset", "upload", "material"
      result.mediaPanel = Array.from(document.querySelectorAll(
        '[class*="media-panel" i], [class*="asset" i], [class*="material-list" i], [class*="panel-material" i], [class*="upload" i]'
      )).slice(0, 10).map(el => ({
        cls: el.className?.toString?.().slice(0, 100),
        childrenCount: el.children.length,
        text: (el.textContent || '').trim().slice(0, 60),
      }));

      // Cari elemen dengan class mengandung "track", "timeline", "clip"
      result.timeline = Array.from(document.querySelectorAll(
        '[class*="track" i], [class*="timeline" i], [class*="clip-item" i], [class*="track-item" i]'
      )).slice(0, 20).map(el => ({
        cls: el.className?.toString?.().slice(0, 100),
        childrenCount: el.children.length,
        text: (el.textContent || '').trim().slice(0, 80),
        tag: el.tagName,
      }));

      // Cari elemen dengan class mengandung "slot", "placeholder", "image-slot"
      result.slots = Array.from(document.querySelectorAll(
        '[class*="slot" i], [class*="placeholder" i], [class*="image-material" i]'
      )).slice(0, 20).map(el => ({
        cls: el.className?.toString?.().slice(0, 100),
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 60),
      }));

      // Cari elemen dengan class mengandung "replace" — biasanya untuk replace template image
      const replaceEls = Array.from(document.querySelectorAll('[class*="replace" i], [data-action*="replace" i]'));
      const replaceBtns = Array.from(document.querySelectorAll('button')).filter(b => /replace/i.test(b.textContent || ''));
      const allReplace = [...replaceEls, ...replaceBtns];
      result.replaceButtons = allReplace.slice(0, 10).map(el => ({
        cls: el.className?.toString?.().slice(0, 100),
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 60),
      }));

      // Cari elemen dengan attribute draggable (gambar/clip yang bisa di-drag)
      result.draggables = Array.from(document.querySelectorAll('[draggable="true"]'))
        .slice(0, 30)
        .map(el => ({
          cls: el.className?.toString?.().slice(0, 80),
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 40),
          hasImg: !!el.querySelector('img'),
          rect: (() => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
        }));

      // Cari canvas (CapCut editor pakai canvas untuk timeline)
      result.canvases = Array.from(document.querySelectorAll('canvas')).slice(0, 5).map(c => {
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), cls: c.className };
      });

      // Export button state
      const exportBtn = document.querySelector('button.export-video-btn');
      if (exportBtn) {
        result.exportBtn = {
          cls: exportBtn.className,
          disabled: exportBtn.disabled,
          hasDisabledClass: exportBtn.classList.contains('lv-btn-disabled'),
          text: exportBtn.textContent?.trim(),
        };
      }

      // Body text snippet (cari clue)
      result.bodyTextSnippet = document.body.innerText.slice(0, 2000);

      return result;
    });

    console.log('\n=== MEDIA PANEL elements ===');
    (editorInfo.mediaPanel || []).forEach((m, i) => {
      console.log(`  [${i}] children=${m.childrenCount} cls="${m.cls}" text="${m.text}"`);
    });

    console.log('\n=== TIMELINE/TRACK elements ===');
    (editorInfo.timeline || []).forEach((m, i) => {
      console.log(`  [${i}] <${m.tag}> children=${m.childrenCount} cls="${m.cls}" text="${m.text}"`);
    });

    console.log('\n=== SLOT/PLACEHOLDER elements ===');
    (editorInfo.slots || []).forEach((m, i) => {
      console.log(`  [${i}] <${m.tag}> cls="${m.cls}" text="${m.text}"`);
    });

    console.log('\n=== REPLACE button candidates ===');
    (editorInfo.replaceButtons || []).forEach((m, i) => {
      console.log(`  [${i}] <${m.tag}> cls="${m.cls}" text="${m.text}"`);
    });

    console.log('\n=== DRAGGABLE elements ===');
    (editorInfo.draggables || []).forEach((m, i) => {
      console.log(`  [${i}] <${m.tag}> ${m.rect.w}x${m.rect.h} hasImg=${m.hasImg} cls="${m.cls}" text="${m.text}"`);
    });

    console.log('\n=== CANVAS elements ===');
    (editorInfo.canvases || []).forEach((m, i) => {
      console.log(`  [${i}] ${m.w}x${m.h} cls="${m.cls}"`);
    });

    console.log('\n=== EXPORT BUTTON STATE ===');
    if (editorInfo.exportBtn) {
      console.log(`  cls          : ${editorInfo.exportBtn.cls}`);
      console.log(`  text         : ${editorInfo.exportBtn.text}`);
      console.log(`  disabled     : ${editorInfo.exportBtn.disabled}`);
      console.log(`  hasDisabledClass: ${editorInfo.exportBtn.hasDisabledClass}`);
    } else {
      console.log('  Tidak ketemu');
    }

    // Step 4: Cek apakah ada tooltip/instruction "Drag to timeline"
    console.log('\n=== BODY TEXT (cari instruction) ===');
    const instructions = (editorInfo.bodyTextSnippet || '')
      .split('\n')
      .filter(line => /drag|drop|replace|click|upload|template|slot|placeholder|timeline/i.test(line))
      .slice(0, 20);
    instructions.forEach(line => console.log(`  ${line.trim().slice(0, 120)}`));

    // Screenshot final
    await page.screenshot({ path: path.join(tmpDir, 'v2-2-final.png'), fullPage: true });
    console.log('\n   final screenshot: tmp/v2-2-final.png');

    // Print captured API calls (filter yang penting)
    console.log('\n=== CAPCUT API CALLS (filtered) ===');
    const importantCalls = apiCalls.filter(c =>
      /template|render|export|draft|create|apply|asset|material|use_template/i.test(c.url)
    );
    if (importantCalls.length === 0) {
      console.log('  Tidak ada API call yang relevan. Total captured:', apiCalls.length);
      // Print semua call pertama 20
      console.log('\n=== All captured calls (first 20) ===');
      apiCalls.slice(0, 20).forEach(c => {
        console.log(`  [${c.status}] ${c.method} ${c.url}`);
      });
    } else {
      importantCalls.forEach(c => {
        console.log(`  [${c.status}] ${c.method} ${c.url}`);
        if (c.bodyPreview) console.log(`       body: ${c.bodyPreview}`);
      });
    }

    console.log('\n=== Inspector v2 selesai ===');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
