// scripts/find-region-templates.js
// Cari CapCut templates yang AVAILABLE di region IP ini.
// Test dengan berbagai keyword & region, untuk setiap template cek apakah editor muncul error.
//
// Usage:
//   node scripts/find-region-templates.js

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const KEYWORDS = ['social', 'vlog', 'love', 'birthday', 'nature', 'business', 'travel', 'food'];
const REGIONS = ['tw', 'hk', 'sg', 'my', 'ph', 'id', 'th', 'vn', 'us'];

async function fetchTemplates(keyword, region, size = 5) {
  const url = 'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_similar_templates';
  const params = {
    keyword, category: keyword, tabs: 'video',
    region_code: region, language: region === 'tw' ? 'zh-tw' : 'en',
    cursor: '', size,
  };
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.capcut.com/',
  };
  try {
    const res = await axios.get(url, { params, headers, timeout: 15000 });
    return res.data?.data?.video_template_list?.video_template_list || [];
  } catch (e) {
    return [];
  }
}

(async () => {
  console.log(`\n=== Find Region Templates ===\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1440,900',
      '--mute-audio'],
  });

  const tested = new Set();
  const results = [];

  try {
    for (const kw of KEYWORDS) {
      for (const region of REGIONS) {
        console.log(`[kw=${kw} region=${region}] fetching templates...`);
        const tpls = await fetchTemplates(kw, region, 3);
        console.log(`   got ${tpls.length} templates`);

        for (const tpl of tpls) {
          const tid = String(tpl.template_id);
          if (tested.has(tid)) continue;
          tested.add(tid);

          const page = await browser.newPage();
          await page.setViewport({ width: 1440, height: 900 });
          await page.setDefaultTimeout(30000);

          try {
            // Pakai URL tanpa prefix region
            const url = `https://www.capcut.com/editor-template?create_id=${tid}`;
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
            const hasError = /couldn.?t edit|unavailable in your country|try other templates|无法编辑/i.test(bodyText);

            const exportInfo = await page.evaluate(() => {
              const btn = document.querySelector('button.export-video-btn');
              if (!btn) return { found: false };
              return {
                found: true,
                disabled: btn.classList.contains('lv-btn-disabled') || btn.disabled,
              };
            });

            const timelineHidden = await page.evaluate(() => {
              const tl = document.querySelector('[class*="timeline" i]');
              if (!tl) return null;
              return /timeline--hidden/i.test(tl.className.toString());
            });

            const editable = !hasError && exportInfo.found && !exportInfo.disabled && !timelineHidden;

            const tplInfo = {
              templateId: tid, title: (tpl.title || '').slice(0, 40),
              keyword: kw, region,
              hasError, exportFound: exportInfo.found, exportDisabled: exportInfo.disabled,
              timelineHidden, editable,
            };
            results.push(tplInfo);
            console.log(`   ${editable ? '✅' : '❌'} ${tid} "${tplInfo.title}" kw=${kw} reg=${region} err=${hasError} expDisabled=${exportInfo.disabled} tlHidden=${timelineHidden}`);

            if (editable) {
              await page.screenshot({ path: path.join(tmpDir, `editable-${tid}.png`), fullPage: false });
              console.log(`      screenshot: tmp/editable-${tid}.png`);
            }
          } catch (e) {
            console.log(`   ❌ ${tid} error: ${e.message}`);
          } finally {
            await page.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  const editable = results.filter(r => r.editable);
  console.log(`Total tested: ${results.length}`);
  console.log(`Editable: ${editable.length}\n`);

  if (editable.length > 0) {
    console.log('=== EDITABLE TEMPLATES ===');
    editable.forEach(t => {
      console.log(`  ✅ id=${t.templateId}  title="${t.title}"  kw=${t.keyword}  reg=${t.region}`);
      console.log(`     editorUrl: https://www.capcut.com/editor-template?create_id=${t.templateId}`);
    });
    fs.writeFileSync(
      path.join(tmpDir, 'editable-templates.json'),
      JSON.stringify(editable, null, 2)
    );
  } else {
    console.log('❌ TIDAK ADA template yang editable dari region manapun.');
    console.log('   Region & error count:');
    const byRegion = {};
    results.forEach(r => {
      if (!byRegion[r.region]) byRegion[r.region] = { total: 0, errors: 0 };
      byRegion[r.region].total++;
      if (r.hasError) byRegion[r.region].errors++;
    });
    Object.entries(byRegion).forEach(([reg, v]) => {
      console.log(`   ${reg}: ${v.errors}/${v.total} error`);
    });
  }
})();
