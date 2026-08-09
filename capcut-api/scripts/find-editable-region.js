// scripts/find-editable-region.js
// Cari region CapCut yang benar-benar editable dari IP ini.
// Test: 5 region x 1 template populer.
//
// Usage:
//   node scripts/find-editable-region.js [templateId]

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

const templateId = process.argv[2] || '7598329412446375173';
const REGIONS = [
  { code: 'en', lang: 'en', label: 'Global/US' },
  { code: 'zh-tw', lang: 'zh-tw', label: 'Taiwan' },
  { code: 'zh-cn', lang: 'zh-cn', label: 'Mainland China' },
  { code: 'ja-jp', lang: 'ja-jp', label: 'Japan' },
  { code: 'ko-kr', lang: 'ko-kr', label: 'Korea' },
  { code: 'id', lang: 'id', label: 'Indonesia' },
  { code: 'th', lang: 'th', label: 'Thailand' },
  { code: 'vi-vn', lang: 'vi-vn', label: 'Vietnam' },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\n=== Find Editable Region (template ${templateId}) ===\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1440,900',
      '--mute-audio'],
  });

  const results = [];

  try {
    for (const r of REGIONS) {
      console.log(`[${r.label}] Testing /${r.lang}/editor-template?create_id=${templateId}`);
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.setDefaultTimeout(30000);

      // Set Accept-Language biar CapCut kasih region-correct content
      await page.setExtraHTTPHeaders({
        'Accept-Language': `${r.lang},en;q=0.9`,
      });

      try {
        const url = `https://www.capcut.com/${r.lang}/editor-template?create_id=${templateId}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(8000);

        // Tutup modals
        for (let j = 0; j < 3; j++) {
          try {
            const close = await page.$('.lv-modal-close-icon');
            if (close) { await close.click(); await sleep(300); }
            await page.keyboard.press('Escape');
            await sleep(200);
          } catch (_) {}
        }

        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
        const hasError = /couldn.?t edit|unavailable|try other templates|无法编辑|无法使用|暂不支持/i.test(bodyText);

        const exportInfo = await page.evaluate(() => {
          const btn = document.querySelector('button.export-video-btn');
          if (!btn) return { found: false };
          return {
            found: true,
            disabled: btn.classList.contains('lv-btn-disabled') || btn.disabled,
          };
        });

        const timelineInfo = await page.evaluate(() => {
          const tl = document.querySelector('[class*="timeline" i]');
          if (!tl) return { found: false };
          return {
            found: true,
            isHidden: /timeline--hidden/i.test(tl.className.toString()),
          };
        });

        const finalUrl = page.url();
        const editable = !hasError && timelineInfo.found && !timelineInfo.isHidden && exportInfo.found && !exportInfo.disabled;

        results.push({ ...r, hasError, exportFound: exportInfo.found, exportDisabled: exportInfo.disabled, timelineHidden: timelineInfo.isHidden, editable, finalUrl });
        console.log(`   editable=${editable} error=${hasError} exportDisabled=${exportInfo.disabled} timelineHidden=${timelineInfo.isHidden}`);
        console.log(`   finalUrl: ${finalUrl}`);

        if (editable) {
          await page.screenshot({ path: path.join(tmpDir, `region-${r.code}-editable.png`), fullPage: false });
          console.log(`   ✅ Screenshot: tmp/region-${r.code}-editable.png`);
        }
      } catch (e) {
        console.log(`   ❌ Error: ${e.message}`);
        results.push({ ...r, error: e.message, editable: false });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== SUMMARY ===');
  const editable = results.filter(r => r.editable);
  console.log(`Editable regions: ${editable.length}/${results.length}\n`);
  if (editable.length > 0) {
    console.log('✅ Editable in:');
    editable.forEach(r => console.log(`   - ${r.label} (${r.lang})`));
  } else {
    console.log('❌ Tidak ada region yang editable dari IP ini.');
    console.log('   CapCut mungkin mendeteksi IP server dan membatasi akses editor.');
    console.log('   Pertimbangkan:');
    console.log('     1. Pakai VPN/proxy ke region yang diizinkan');
    console.log('     2. Login dengan akun CapCut region berbeda');
    console.log('     3. Pakai CapCut mobile app instead');
    console.log('');
    console.log('   Detail per region:');
    results.forEach(r => {
      console.log(`   - ${r.label.padEnd(20)} error=${r.hasError} exportDisabled=${r.exportDisabled} timelineHidden=${r.timelineHidden}`);
    });
  }
})();
