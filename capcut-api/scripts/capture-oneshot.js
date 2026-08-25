#!/usr/bin/env node
/**
 * capture-oneshot.js — kunci pure-API paling efisien
 *
 * Satu session valid + satu template → dump body plane_draft/save + create_cloud_asset.
 * Hasil dipakai /render-direct sebagai "golden fixture" (replay + patch asset_id).
 *
 * Usage:
 *   # Pastikan sudah paste cookies di /login (cookies.json ada)
 *   node scripts/capture-oneshot.js [templateIdOrUrl]
 *   # atau headless server:
 *   xvfb-run -a node scripts/capture-oneshot.js 7123456789012345678
 *
 * Output:
 *   tmp/captured-save-body.json   — body POST plane_draft/save (full)
 *   tmp/captured-api.jsonl        — semua request relevan
 *   tmp/captured-summary.json     — ringkasan endpoint + status
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const USER_DATA_DIR =
  process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');
const COOKIE_FILE = path.join(USER_DATA_DIR, 'cookies.json');
const OUT_DIR = path.join(projectRoot, 'tmp');
const OUT_SAVE = path.join(OUT_DIR, 'captured-save-body.json');
const OUT_LOG = path.join(OUT_DIR, 'captured-api.jsonl');
const OUT_SUMMARY = path.join(OUT_DIR, 'captured-summary.json');

const TARGET = [
  'plane_draft/save',
  'plane_draft/get_draft_detail',
  'render_task/create',
  'render_task/batch_get',
  'create_cloud_asset',
  'prepare_upload_cloud',
  'upload_sign',
  'get_template_file',
  'get_template_detail',
  'multi_get_templates',
];

function extractTemplateId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{15,25}$/.test(s)) return s;
  const m =
    s.match(/create_id[=](\d+)/) ||
    s.match(/\/template-detail\/[^/]+\/(\d+)/) ||
    s.match(/\/templates\/detail\/(\d+)/) ||
    s.match(/(\d{15,25})/);
  return m ? m[1] : null;
}

async function injectCookies(page) {
  if (!fs.existsSync(COOKIE_FILE)) {
    console.error(`✗ cookies.json tidak ada: ${COOKIE_FILE}`);
    console.error('  → Jalankan server, buka /login, paste cookies CapCut dulu.');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  const arr = Array.isArray(raw) ? raw : raw.cookies || [];
  if (!arr.length) {
    console.error('✗ cookies.json kosong');
    process.exit(1);
  }
  await page.goto('https://www.capcut.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const cookies = arr
    .filter((c) => c.name && c.value != null)
    .map((c) => {
      let domain = (c.domain || '.capcut.com').replace(/^\./, '');
      if (!/capcut|bytedance|byteoversea/i.test(domain)) domain = 'capcut.com';
      const cookie = {
        name: c.name,
        value: String(c.value),
        domain: domain.startsWith('.') ? domain : `.${domain}`,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        sameSite: 'Lax',
      };
      if (c.expires && Number.isFinite(c.expires) && c.expires > 0) cookie.expires = c.expires;
      return cookie;
    });
  await page.setCookie(...cookies);
  console.log(`✓ Injected ${cookies.length} cookies dari cookies.json`);
}

async function main() {
  const arg = process.argv[2] || process.env.TEMPLATE_ID || '';
  const templateId = extractTemplateId(arg);
  if (!templateId) {
    console.error('Usage: node scripts/capture-oneshot.js <templateId|url>');
    console.error('Example: node scripts/capture-oneshot.js 7123456789012345678');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true });
    } catch {}
  }

  console.log('=== Capture One-Shot ===');
  console.log(`template: ${templateId}`);
  console.log(`profile:  ${USER_DATA_DIR}`);
  console.log(`output:   ${OUT_SAVE}\n`);

  const { default: puppeteer } = await import('puppeteer');
  const headless = process.env.HEADLESS !== 'false';
  const browser = await puppeteer.launch({
    headless,
    userDataDir: USER_DATA_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
      '--enable-webgl',
      '--mute-audio',
    ],
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 300000,
  });

  const page = (await browser.pages())[0] || (await browser.newPage());
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  await injectCookies(page);

  const logStream = fs.createWriteStream(OUT_LOG, { flags: 'w' });
  const summary = { templateId, saves: [], assets: [], renders: [], other: [] };
  let saveBody = null;

  const onReq = (req) => {
    try {
      const url = req.url();
      if (!TARGET.some((t) => url.includes(t))) return;
      const entry = {
        ts: Date.now(),
        kind: 'request',
        method: req.method(),
        url,
        postData: req.postData() || null,
      };
      logStream.write(JSON.stringify(entry) + '\n');
      if (url.includes('plane_draft/save') && entry.postData) {
        try {
          saveBody = JSON.parse(entry.postData);
          fs.writeFileSync(OUT_SAVE, JSON.stringify(saveBody, null, 2));
          summary.saves.push({ url, len: entry.postData.length });
          console.log(`★ Captured plane_draft/save (${entry.postData.length} bytes) → ${OUT_SAVE}`);
        } catch (e) {
          console.warn('plane_draft/save postData not JSON:', e.message);
        }
      }
      if (url.includes('create_cloud_asset')) summary.assets.push({ url });
      if (url.includes('render_task/create')) summary.renders.push({ url });
    } catch {}
  };

  const onRes = async (res) => {
    try {
      const url = res.url();
      if (!TARGET.some((t) => url.includes(t))) return;
      let body = null;
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) body = await res.text();
      } catch {}
      const entry = {
        ts: Date.now(),
        kind: 'response',
        status: res.status(),
        url,
        body: body ? body.slice(0, 20000) : null,
      };
      logStream.write(JSON.stringify(entry) + '\n');
      if (url.includes('plane_draft/save')) {
        console.log(`  ← save response status=${res.status()}`);
      }
    } catch {}
  };

  page.on('request', onReq);
  page.on('response', onRes);

  const editorUrl = `https://www.capcut.com/editor-template?create_id=${templateId}`;
  console.log(`Opening editor: ${editorUrl}`);
  await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(12000);

  if (/\/login/.test(page.url())) {
    console.error('✗ Redirected to login — cookies expired. Refresh via /login.');
    await browser.close();
    process.exit(1);
  }

  // Tutup modal
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      document.querySelectorAll('.lv-modal-close-icon, [aria-label*="close" i]').forEach((el) => {
        try {
          el.click();
        } catch {}
      });
    }).catch(() => {});
    await sleep(500);
  }

  // Coba trigger file input + upload sample image jika ada
  const sampleImages = [
    path.join(projectRoot, 'test-assets', 'img1.jpg'),
    path.join(projectRoot, 'test-assets', 'img2.jpg'),
  ].filter((p) => fs.existsSync(p));

  if (sampleImages.length) {
    console.log(`Uploading ${sampleImages.length} sample image(s)...`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const input = await page.$('input[type="file"]');
      if (input) {
        await input.uploadFile(...sampleImages);
        console.log('✓ uploadFile done');
        await sleep(15000);
        break;
      }
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [class*="upload" i]'));
        const t = btns.find((el) => /upload|import|replace/i.test(el.innerText || el.className || ''));
        if (t) t.click();
      });
      await sleep(2000);
    }
  } else {
    console.log('No test-assets images — waiting for auto-save / manual interaction...');
  }

  // Tunggu save body sampai timeout
  const deadline = Date.now() + (Number(process.env.CAPTURE_WAIT_MS) || 120000);
  while (!saveBody && Date.now() < deadline) {
    await sleep(3000);
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  // Coba klik Export kalau belum ada save (kadang save terjadi saat export)
  if (!saveBody) {
    console.log('Belum ada save — coba klik Export...');
    await page.evaluate(() => {
      const btn = document.querySelector('button.export-video-btn');
      if (btn && !btn.classList.contains('lv-btn-disabled')) btn.click();
    }).catch(() => {});
    await sleep(20000);
  }

  page.off('request', onReq);
  page.off('response', onRes);
  logStream.end();
  fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));

  if (saveBody) {
    console.log('\n✅ SUCCESS');
    console.log(`  plane_draft/save body → ${OUT_SAVE}`);
    console.log(`  Full log               → ${OUT_LOG}`);
    console.log(`  Summary                → ${OUT_SUMMARY}`);
    console.log('\nNext: pure-API bisa replay body ini (patch asset_id saja).');
  } else {
    console.log('\n⚠ Tidak ada plane_draft/save tertangkap.');
    console.log('  Coba: HEADLESS=false TEMPLATE lebih stabil, atau upload manual di jendela browser.');
    console.log(`  Log tetap ada di ${OUT_LOG}`);
  }

  await browser.close();
  process.exit(saveBody ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
