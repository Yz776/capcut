// scripts/test-use-template-flow.js
// Test flow yang benar: buka detail page → klik "Use template" → masuk editor dengan auth penuh.
// Ini bypass issue "check login error" dari API editor.
//
// Usage:
//   node scripts/test-use-template-flow.js <templateId> [img1] [img2]

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
const templateId = process.argv[2] || '7106084142965673217';
const imagePaths = process.argv.slice(3).filter(p => !p.startsWith('-'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n=== Test "Use template" Flow ===`);
  console.log(`templateId: ${templateId}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1440,900',
      '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle',
      '--mute-audio'],
  });

  // Track API calls
  const apiCalls = [];
  const apiFailures = [];

  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    await page.setViewport({ width: 1440, height: 900 });
    await page.setDefaultTimeout(60000);

    page.on('response', async (res) => {
      const url = res.url();
      if (!/edit-api-sg\.capcut\.com|luckycat/.test(url)) return;
      if (/\.(js|css|png|jpg|webp)(\?|$)/.test(url)) return;
      try {
        const status = res.status();
        const ct = res.headers()['content-type'] || '';
        let body = '';
        if (ct.includes('json')) {
          try { body = await res.text(); } catch (_) {}
        }
        apiCalls.push({ url: url.slice(0, 200), status, body: body.slice(0, 200) });
        if (body.includes('"ret":"') && !body.includes('"ret":"0"')) {
          apiFailures.push({ url: url.slice(0, 200), body: body.slice(0, 200) });
        }
      } catch (_) {}
    });

    // Step 1: Buka detail page
    const detailUrl = `${BASE_URL}/zh-tw/template-detail/x/${templateId}`;
    console.log(`\n[1] Opening detail page: ${detailUrl}`);
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await page.screenshot({ path: path.join(tmpDir, 'flow-1-detail.png'), fullPage: false });

    // Tutup modals
    for (let i = 0; i < 3; i++) {
      try {
        const close = await page.$('.lv-modal-close-icon');
        if (close) { await close.click(); await sleep(300); }
        await page.keyboard.press('Escape');
        await sleep(200);
      } catch (_) {}
    }

    // Step 2: Cari & klik "Use template" / "使用範本" / "使用模板" button
    console.log('[2] Looking for "Use template" button...');
    let useTemplateBtn = null;

    // Cari berbagai varian selector
    const selectors = [
      '.btn-use-template',
      '[class*="use-template" i]',
      '[class*="useTemplate" i]',
      'button:has-text("Use template")',
      'a:has-text("Use template")',
      'button:has-text("使用範本")',
      'a:has-text("使用範本")',
      'button:has-text("使用模板")',
      'a:has-text("使用模板")',
      'button:has-text("Use this template")',
    ];

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          useTemplateBtn = el;
          console.log(`   ✅ Found via selector: ${sel}`);
          break;
        }
      } catch (_) {}
    }

    // Fallback: cari semua button/a dengan text "template" / "範本" / "模板"
    if (!useTemplateBtn) {
      const allClickable = await page.$$('button, a, [role="button"]');
      console.log(`   checking ${allClickable.length} button/a elements...`);
      for (const el of allClickable) {
        try {
          const text = await el.evaluate(e => (e.textContent || '').trim());
          if (/use\s*(this\s*)?template|使用範本|使用模板/i.test(text)) {
            useTemplateBtn = el;
            console.log(`   ✅ Found via text: "${text}"`);
            break;
          }
        } catch (_) {}
      }
    }

    if (!useTemplateBtn) {
      console.log('   ❌ Use template button tidak ketemu');
      // Cek apa isi body
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      console.log('   Body text snippet:', bodyText.slice(0, 500));
      await page.screenshot({ path: path.join(tmpDir, 'flow-no-use-btn.png'), fullPage: true });
    } else {
      // Klik Use template
      console.log('   Clicking Use template...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        useTemplateBtn.click(),
      ]);
      await sleep(3000);
      console.log(`   After click, URL: ${page.url()}`);
      await page.screenshot({ path: path.join(tmpDir, 'flow-2-after-use-click.png'), fullPage: false });

      // Tunggu editor load
      console.log('[3] Waiting for editor to load (30s)...');
      await sleep(30000);

      // Tutup modals
      for (let i = 0; i < 5; i++) {
        try {
          const close = await page.$('.lv-modal-close-icon');
          if (close) { await close.click(); await sleep(400); continue; }
        } catch (_) {}
        try { await page.keyboard.press('Escape'); await sleep(300); } catch (_) {}
        const still = await page.evaluate(() => {
          const m = document.querySelector('.lv-modal-mask, .lv-modal-wrapper');
          return m && m.offsetParent !== null;
        });
        if (!still) break;
      }

      await page.screenshot({ path: path.join(tmpDir, 'flow-3-editor-loaded.png'), fullPage: false });

      // Step 4: Cek editor state
      console.log('[4] Checking editor state...');
      const editorState = await page.evaluate(() => {
        const exportBtn = document.querySelector('button.export-video-btn');
        const timeline = document.querySelector('[class*="timeline" i]');
        return {
          url: location.href,
          title: document.title,
          bodyTextLen: document.body.innerText.length,
          bodyTextStart: document.body.innerText.slice(0, 500),
          exportBtn: exportBtn ? {
            cls: exportBtn.className,
            disabled: exportBtn.classList.contains('lv-btn-disabled'),
            text: exportBtn.textContent?.trim(),
          } : null,
          timelineCls: timeline?.className?.toString(),
          hasUseTemplateModal: !!document.querySelector('[class*="sign_in_panel" i]'),
        };
      });
      console.log('   URL:', editorState.url);
      console.log('   Title:', editorState.title);
      console.log('   Body text len:', editorState.bodyTextLen);
      console.log('   Body text start:', editorState.bodyTextStart.slice(0, 200));
      console.log('   Export btn:', JSON.stringify(editorState.exportBtn));
      console.log('   Timeline cls:', editorState.timelineCls);
      console.log('   Sign-in modal visible:', editorState.hasUseTemplateModal);

      // Step 5: Upload images kalau editor OK
      if (editorState.exportBtn && !editorState.exportBtn.disabled && imagePaths.length > 0) {
        console.log('\n[5] Uploading images...');
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.uploadFile(...imagePaths.map(p => path.resolve(p)));
          console.log('   Images uploaded, waiting 15s...');
          await sleep(15000);
          await page.screenshot({ path: path.join(tmpDir, 'flow-4-after-upload.png'), fullPage: false });

          // Coba klik "Batch replace" untuk apply images ke template slots
          console.log('   Looking for "Batch replace" button...');
          const batchReplace = await page.$('.timeline-batch-replace-btn, .timeline-upload-and-replace-btn');
          if (batchReplace) {
            await batchReplace.click();
            console.log('   Clicked Batch replace');
            await sleep(5000);
            await page.screenshot({ path: path.join(tmpDir, 'flow-5-batch-replace.png'), fullPage: false });
          }

          // Re-check export button state
          const exportInfo2 = await page.evaluate(() => {
            const btn = document.querySelector('button.export-video-btn');
            return btn ? {
              cls: btn.className,
              disabled: btn.classList.contains('lv-btn-disabled'),
            } : null;
          });
          console.log('   Export btn after upload:', JSON.stringify(exportInfo2));
        } else {
          console.log('   ❌ file input tidak ketemu');
        }
      }
    }

    // Print API failures
    console.log('\n=== API CALLS ===');
    console.log(`Total: ${apiCalls.length}`);
    console.log(`Failures: ${apiFailures.length}`);
    if (apiFailures.length > 0) {
      console.log('\nFailed API calls:');
      apiFailures.forEach((f, i) => {
        console.log(`  [${i}] ${f.url}`);
        console.log(`       ${f.body}`);
      });
    }

    console.log('\n=== Test selesai ===');
    console.log('Lihat screenshots di tmp/flow-*.png');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
