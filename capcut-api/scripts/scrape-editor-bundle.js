// scripts/scrape-editor-bundle.js
//
// Static reverse engineering approach:
//   1. Launch puppeteer with .capcut-profile (logged-in) just to read cookies.
//   2. Fetch editor-template HTML via axios with those cookies.
//   3. Extract all <script src> URLs.
//   4. Download each JS bundle.
//   5. Grep for API endpoint patterns.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';
const OUT_DIR = path.join(projectRoot, 'tmp', 'editor-bundle');
fs.mkdirSync(OUT_DIR, { recursive: true });

const USER_DATA_DIR = path.join(projectRoot, '.capcut-profile');

async function getCookiesFromProfile() {
  // Cleanup locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(USER_DATA_DIR, lock), { force: true });
  }
  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto('https://www.capcut.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const cookies = await browser.cookies('https://www.capcut.com', 'https://capcut.com');
    return cookies;
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('[bundle] Loading cookies from profile...');
  const cookies = await getCookiesFromProfile();
  console.log(`[bundle] Got ${cookies.length} cookies`);

  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const client = axios.create({
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': cookieHeader,
      'Referer': 'https://www.capcut.com/',
    },
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: s => s < 500,
  });

  // 1. Fetch editor HTML
  const editorUrl = `https://www.capcut.com/editor-template?create_id=${TEMPLATE_ID}`;
  console.log(`[bundle] Fetching ${editorUrl}`);
  const res = await client.get(editorUrl);
  const html = res.data;
  console.log(`[bundle] HTML status ${res.status}, ${html.length} bytes`);

  if (res.status === 200 && html.length < 5000) {
    console.error('[bundle] WARNING: very short HTML — might be redirect or error page');
    fs.writeFileSync(path.join(OUT_DIR, 'editor-short.html'), html);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'editor.html'), html);

  // 2. Extract script src URLs
  const scriptUrls = [];
  const scriptRegex = /<script[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = scriptRegex.exec(html)) !== null) {
    const src = m[1];
    if (src.startsWith('http')) scriptUrls.push(src);
    else if (src.startsWith('//')) scriptUrls.push('https:' + src);
    else if (src.startsWith('/')) scriptUrls.push('https://www.capcut.com' + src);
  }
  const unique = [...new Set(scriptUrls)];
  console.log(`[bundle] Found ${unique.length} script URLs`);
  fs.writeFileSync(path.join(OUT_DIR, 'script-urls.txt'), unique.join('\n') + '\n');

  // 3. Download each bundle (skip analytics)
  const bigBundles = unique.filter(u => !/analytics|sentry|google|facebook|gtag|beacon|hotjar|googletag/i.test(u));
  console.log(`[bundle] Downloading ${bigBundles.length} bundles (filtered)`);

  const endpointPatterns = [
    /\/api\/v\d+\/[a-z_/-]+/gi,
    /\/luckycat\/[^"'\s,)]{3,80}/gi,
    /\/lapi\/[^"'\s,)]{3,80}/gi,
    /\/mcp\/[^"'\s,)]{3,80}/gi,
    /\/cc\/v\d+\/[a-z_/-]+/gi,
    /\/lv\/v\d+\/[a-z_/-]+/gi,
    /\/commerce\/v\d+\/[a-z_/-]+/gi,
    /\/vc\/[a-z_/-]+/gi,
    /["'`](\/[a-z0-9_/-]{5,80}(?:render|export|compile|draft|publish|upload|task|job|project|cutout|vedit|material|editor|create)[a-z0-9_/-]*)["'`]/gi,
  ];

  const allEndpoints = new Set();
  const renderEndpoints = new Set();
  const fileEndpoints = new Map(); // endpoint -> file index

  for (let i = 0; i < bigBundles.length; i++) {
    const url = bigBundles[i];
    const fname = `bundle-${String(i).padStart(3, '0')}.js`;
    const fpath = path.join(OUT_DIR, fname);
    try {
      const r = await client.get(url, { responseType: 'text', timeout: 60000 });
      fs.writeFileSync(fpath, r.data);
      const sizeKB = Math.round(r.data.length / 1024);
      console.log(`  [${i + 1}/${bigBundles.length}] ${url.slice(-80)} (${sizeKB} KB)`);

      for (const p of endpointPatterns) {
        const matches = r.data.match(p) || [];
        for (const mt of matches) {
          const clean = mt.replace(/^["'`]|["'`]$/g, '');
          allEndpoints.add(clean);
          if (!fileEndpoints.has(clean)) fileEndpoints.set(clean, fname);
          if (/render|export|compile|draft|publish/i.test(mt)) {
            renderEndpoints.add(clean);
          }
        }
      }
    } catch (e) {
      console.log(`  [${i + 1}/${bigBundles.length}] FAIL ${url.slice(-80)}: ${e.message}`);
    }
  }

  // 4. Save endpoints
  const endpointsFile = path.join(OUT_DIR, 'endpoints.txt');
  fs.writeFileSync(endpointsFile, [...allEndpoints].sort().join('\n') + '\n');
  const renderFile = path.join(OUT_DIR, 'render-endpoints.txt');
  fs.writeFileSync(renderFile, [...renderEndpoints].sort().join('\n') + '\n');

  // 5. Save mapping endpoint -> file
  const mapFile = path.join(OUT_DIR, 'endpoint-to-file.txt');
  const mapLines = [...allEndpoints].sort().map(e => `${e}\t${fileEndpoints.get(e)}`);
  fs.writeFileSync(mapFile, mapLines.join('\n') + '\n');

  console.log(`\n[bundle] Total endpoints found: ${allEndpoints.size}`);
  console.log(`[bundle] Render-related: ${renderEndpoints.size}`);
  console.log(`[bundle] Endpoints: ${endpointsFile}`);
  console.log(`[bundle] Render endpoints: ${renderFile}`);

  console.log('\n=== Render-related endpoints ===');
  for (const e of [...renderEndpoints].sort()) {
    console.log(`  ${e}  [${fileEndpoints.get(e)}]`);
  }

  console.log('\n=== All endpoints (sample 50) ===');
  for (const e of [...allEndpoints].sort().slice(0, 50)) {
    console.log(`  ${e}  [${fileEndpoints.get(e)}]`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
