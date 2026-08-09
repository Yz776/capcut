// scripts/inspect-editor.js
// Buka CapCut editor untuk template tertentu, upload images, screenshot, dump semua tombol.
// Tujuan: cari selector Export/Render button yang benar setelah CapCut update UI.
//
// Usage:
//   node scripts/inspect-editor.js <templateId> [imgPath1] [imgPath2]
//   node scripts/inspect-editor.js 7598329412446375173 ./test-assets/img1.jpg ./test-assets/img2.jpg

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
  console.error('Usage: node scripts/inspect-editor.js <templateId> <imgPath1> [imgPath2]...');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n=== CapCut Editor Inspector ===`);
  console.log(`templateId : ${templateId}`);
  console.log(`images     : ${imagePaths.join(', ')}`);
  console.log(`userDataDir: ${userDataDir}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-gl=angle',
      '--mute-audio',
    ],
  });

  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.setDefaultTimeout(60000);

    // Step 1: Verify session
    console.log('[1/6] Verifying session at homepage...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const cookies = await browser.cookies();
    const hasPassport = cookies.some(c => c.name.includes('passport'));
    console.log(`   passport cookie: ${hasPassport ? 'YES ✅' : 'NO ❌'}`);
    if (!hasPassport) {
      console.error('   Session tidak valid. Jalankan: npm run login:manual');
      process.exit(2);
    }

    // Step 2: Buka editor
    console.log(`[2/6] Opening editor for template ${templateId}...`);
    const editorUrl = `${BASE_URL}/editor-template?create_id=${templateId}`;
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    console.log(`   current URL: ${page.url()}`);
    if (/\/login/.test(page.url())) {
      console.error('   Di-redirect ke login. Session expired.');
      await page.screenshot({ path: path.join(tmpDir, 'editor-redirected-login.png') });
      process.exit(2);
    }
    await page.screenshot({ path: path.join(tmpDir, 'editor-1-loaded.png'), fullPage: false });
    console.log(`   screenshot 1: tmp/editor-1-loaded.png`);

    // Step 3: Tunggu editor SPA load (heavy)
    console.log('[3/6] Waiting for editor SPA to load (up to 60s)...');
    await sleep(20000); // kasih waktu buat load WebGL
    await page.screenshot({ path: path.join(tmpDir, 'editor-2-after-20s.png'), fullPage: false });
    console.log(`   screenshot 2: tmp/editor-2-after-20s.png`);

    // Step 4: Cari file input + upload
    console.log('[4/6] Looking for file input...');
    let fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      // Coba klik tombol upload
      console.log('   file input tidak langsung ketemu, cari tombol upload...');
      const uploadBtnCandidates = await page.$$('button, a, [role="button"]');
      console.log(`   total button candidates: ${uploadBtnCandidates.length}`);
      for (const btn of uploadBtnCandidates.slice(0, 20)) {
        try {
          const text = await btn.evaluate(el => el.textContent?.trim().slice(0, 30));
          if (text && /upload|import|media|上傳|導入/i.test(text)) {
            console.log(`   clicking button: "${text}"`);
            await btn.click();
            await sleep(2000);
            fileInput = await page.$('input[type="file"]');
            if (fileInput) break;
          }
        } catch (_) {}
      }
    }
    if (!fileInput) {
      console.error('   ❌ file input tidak ketemu setelah click');
      await page.screenshot({ path: path.join(tmpDir, 'editor-no-fileinput.png'), fullPage: true });
    } else {
      console.log('   file input ditemukan, uploading images...');
      await fileInput.uploadFile(...imagePaths.map(p => path.resolve(p)));
      await sleep(8000);
      await page.screenshot({ path: path.join(tmpDir, 'editor-3-after-upload.png'), fullPage: false });
      console.log(`   screenshot 3: tmp/editor-3-after-upload.png`);
    }

    // Step 5: Dump semua tombol yang ada
    console.log('[5/6] Dumping all buttons in editor...');
    const buttons = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="btn" i]'));
      return els.slice(0, 100).map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 50),
        cls: el.className?.toString?.() || '',
        id: el.id || '',
        title: el.getAttribute('title') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-e2e') || '',
      }));
    });
    console.log(`\n   Found ${buttons.length} buttons (showing first 30):\n`);
    buttons.slice(0, 30).forEach((b, i) => {
      console.log(`   [${i}] <${b.tag}> "${b.text}" | cls="${b.cls.slice(0, 60)}" | title="${b.title}" | testid="${b.dataTestId}"`);
    });

    // Filter button yang mungkin Export/Render
    const exportCandidates = buttons.filter(b =>
      /export|render|download|save|匯出|下載|渲染|导出|下载/i.test(b.text + ' ' + b.title + ' ' + b.ariaLabel)
    );
    console.log(`\n   === Export/Render button candidates ===`);
    if (exportCandidates.length === 0) {
      console.log('   ❌ Tidak ada button yang cocok dengan "Export/Render/Download"');
      console.log('   CapCut mungkin pakai icon-only button atau text berbeda');
    } else {
      exportCandidates.forEach((b, i) => {
        console.log(`   [${i}] <${b.tag}> "${b.text}" | cls="${b.cls}" | testid="${b.dataTestId}"`);
      });
    }

    // Step 6: Cek modal/dialog yang mungkin nge-block
    console.log('\n[6/6] Checking for blocking modals/dialogs...');
    const modals = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[class*="modal" i], [class*="dialog" i], [class*="overlay" i], [role="dialog"]'));
      return els.map(el => ({
        tag: el.tagName,
        cls: el.className?.toString?.() || '',
        text: (el.textContent || '').trim().slice(0, 80),
        visible: el.offsetParent !== null,
      }));
    });
    console.log(`   Found ${modals.length} modal candidates:`);
    modals.forEach((m, i) => {
      console.log(`   [${i}] visible=${m.visible} <${m.tag}> cls="${m.cls.slice(0, 60)}" text="${m.text}"`);
    });

    // Final screenshot
    await page.screenshot({ path: path.join(tmpDir, 'editor-4-final.png'), fullPage: true });
    console.log(`\n   final screenshot: tmp/editor-4-final.png`);

    console.log('\n=== Inspector selesai ===');
    console.log('Lihat screenshot di tmp/ untuk lihat state editor.');
    console.log('Berdasarkan button dump di atas, update SELECTORS.renderButton di src/services/capcut-browser.js');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    try {
      const page = (await browser.pages())[0];
      if (page) await page.screenshot({ path: path.join(tmpDir, 'editor-error.png'), fullPage: true });
    } catch (_) {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
