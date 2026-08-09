// scripts/find-editable-template.js
// Cari template CapCut yang BENAR-BENAR bisa di-edit (tidak error "unavailable in your country").
// Strategi: untuk setiap template dari list, coba buka editor-template, cek apakah muncul
// error "Couldn't edit" atau class "timeline--hidden".
//
// Usage:
//   node scripts/find-editable-template.js [count=10]

import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = process.env.CAPCUT_USER_DATA_DIR || path.resolve(projectRoot, '.capcut-profile');
const tmpDir = path.resolve(projectRoot, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const BASE_URL = process.env.CAPCUT_BASE_URL || 'https://www.capcut.com';
const COUNT = parseInt(process.argv[2] || '10', 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fetch templates list via axios (sama kayak di capcut-api.js)
async function listTemplates(size = COUNT) {
  const url = 'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_similar_templates';
  const params = {
    keyword: 'social',
    category: 'social',
    tabs: 'video',
    region_code: 'tw',
    language: 'zh-tw',
    cursor: '',
    size,
  };
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': BASE_URL + '/',
  };
  const res = await axios.get(url, { params, headers, timeout: 30000 });
  const data = res.data?.data || {};
  const list = data.video_template_list?.video_template_list || data.templates || [];
  return list;
}

(async () => {
  console.log(`\n=== Find Editable Template ===`);
  console.log(`Fetching ${COUNT} templates from CapCut...\n`);

  const templates = await listTemplates(COUNT);
  console.log(`Got ${templates.length} templates\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1440,900',
      '--mute-audio'],
  });

  const results = [];

  try {
    for (let i = 0; i < templates.length; i++) {
      const tpl = templates[i];
      const tid = tpl.id || tpl.template_id;
      const title = (tpl.title || tpl.name || '').slice(0, 40);
      console.log(`[${i + 1}/${templates.length}] Testing template ${tid} "${title}"...`);

      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.setDefaultTimeout(30000);

      try {
        await page.goto(`${BASE_URL}/editor-template?create_id=${tid}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(8000); // kasih waktu untuk SPA load + API call

        // Tutup modals
        for (let j = 0; j < 3; j++) {
          try {
            const close = await page.$('.lv-modal-close-icon');
            if (close) { await close.click(); await sleep(300); }
            await page.keyboard.press('Escape');
            await sleep(200);
          } catch (_) {}
        }

        // Cek apakah muncul error "unavailable" atau "Couldn't edit"
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
        const hasError = /couldn.?t edit|unavailable in your country|template is unavailable|try other templates/i.test(bodyText);

        // Cek timeline class
        const timelineInfo = await page.evaluate(() => {
          const tl = document.querySelector('[class*="timeline" i]');
          if (!tl) return { found: false };
          return {
            found: true,
            cls: tl.className.toString(),
            isHidden: /timeline--hidden/i.test(tl.className.toString()),
          };
        });

        // Cek export button
        const exportInfo = await page.evaluate(() => {
          const btn = document.querySelector('button.export-video-btn');
          if (!btn) return { found: false };
          return {
            found: true,
            disabled: btn.classList.contains('lv-btn-disabled') || btn.disabled,
            text: btn.textContent?.trim(),
          };
        });

        const editable = !hasError && timelineInfo.found && !timelineInfo.isHidden;
        results.push({
          id: tid, title,
          hasError, timelineHidden: timelineInfo.isHidden,
          exportFound: exportInfo.found, exportDisabled: exportInfo.disabled,
          editable,
        });
        console.log(`   editable=${editable} error=${hasError} timelineHidden=${timelineInfo.isHidden} exportDisabled=${exportInfo.disabled}`);
        if (editable) {
          await page.screenshot({ path: path.join(tmpDir, `editable-${tid}.png`), fullPage: false });
          console.log(`   ✅ Screenshot saved: tmp/editable-${tid}.png`);
        }
      } catch (e) {
        console.log(`   ❌ Error: ${e.message}`);
        results.push({ id: tid, title, error: e.message, editable: false });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  // Print summary
  console.log('\n=== SUMMARY ===');
  const editableTemplates = results.filter(r => r.editable);
  console.log(`\nTotal tested : ${results.length}`);
  console.log(`Editable     : ${editableTemplates.length}`);
  console.log(`Not editable : ${results.length - editableTemplates.length}\n`);

  if (editableTemplates.length > 0) {
    console.log('=== EDITABLE TEMPLATES (use this for testing) ===');
    editableTemplates.forEach(t => {
      console.log(`  ✅ ${t.id}  "${t.title}"  editorUrl: ${BASE_URL}/editor-template?create_id=${t.id}`);
    });
  } else {
    console.log('❌ TIDAK ADA template yang editable. Kemungkinan:');
    console.log('   1. Region/IP CapCut tidak support (perlu VPN/region change)');
    console.log('   2. Account CapCut tidak punya akses editor (perlu login ulang)');
    console.log('   3. CapCut mengubah policy template (perlu pakai template baru)');
  }

  // Save results
  fs.writeFileSync(
    path.join(tmpDir, 'find-editable-result.json'),
    JSON.stringify(results, null, 2)
  );
  console.log(`\nFull results: tmp/find-editable-result.json`);
})();
