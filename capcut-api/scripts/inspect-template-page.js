// scripts/inspect-template-page.js
//
// Visit the public template-detail page and capture all API calls.
// The page must make some call to fetch the template content for display.

import fs from 'node:fs';
import path from 'node:path';

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';
const REGION = process.argv[3] || 'zh-tw';
const URL = `https://www.capcut.com/${REGION}/template-detail/x/${TEMPLATE_ID}`;

const { default: puppeteer } = await import('puppeteer');

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const requests = [];
const responses = [];

try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('capcut') && !url.includes('ibyteimg') && !url.includes('capcutvod')) return;
    if (req.method() === 'OPTIONS') return;
    // Only log API/XHR calls, not static assets
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) return;
    if (url.endsWith('.js') || url.endsWith('.wasm') || url.endsWith('.mjs')) return;

    const postData = req.postData() || '';
    requests.push({
      method: req.method(),
      url,
      resourceType,
      postData: postData.length > 500 ? postData.slice(0, 500) + '...' : postData,
    });
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('capcut') && !url.includes('capcutapi')) return;
    if (url.endsWith('.js') || url.endsWith('.wasm') || url.endsWith('.mjs')) return;
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;

    try {
      const body = await res.text();
      responses.push({
        status: res.status(),
        url,
        body: body.length > 1500 ? body.slice(0, 1500) + '...' : body,
      });
    } catch (e) {}
  });

  console.log(`Visiting ${URL}...`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Also check the page HTML for any embedded template data
  const html = await page.content();
  const scriptTags = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script');
    return Array.from(scripts).map(s => ({
      type: s.type,
      content: s.textContent?.slice(0, 500),
      src: s.src,
    }));
  });

  console.log(`\nCaptured ${requests.length} API requests and ${responses.length} JSON responses\n`);

  console.log('=== Requests ===');
  for (const r of requests) {
    console.log(`  ${r.method} ${r.url}`);
    if (r.postData) console.log(`    body: ${r.postData}`);
  }

  console.log('\n=== JSON Responses ===');
  for (const r of responses) {
    console.log(`  [${r.status}] ${r.url}`);
    console.log(`    body: ${r.body.slice(0, 800)}`);
  }

  // Check for embedded JSON-LD or __NEXT_DATA__
  const nextData = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent?.slice(0, 3000) : null;
  });
  if (nextData) {
    console.log('\n=== __NEXT_DATA__ (first 3000 chars) ===');
    console.log(nextData);
  }

  // Look for any window.__INITIAL_STATE__ or similar
  const windowState = await page.evaluate(() => {
    const keys = Object.keys(window).filter(k => 
      k.startsWith('__') && typeof window[k] === 'object'
    );
    const result = {};
    for (const k of keys) {
      try {
        result[k] = JSON.stringify(window[k]).slice(0, 1000);
      } catch { result[k] = '[unserializable]'; }
    }
    return result;
  });
  if (Object.keys(windowState).length > 0) {
    console.log('\n=== window.__* state ===');
    for (const [k, v] of Object.entries(windowState)) {
      console.log(`  ${k}: ${v.slice(0, 500)}`);
    }
  }

  // Save full capture
  fs.mkdirSync('./tmp', { recursive: true });
  fs.writeFileSync('./tmp/template-page-capture.json', JSON.stringify({ requests, responses, nextData, windowState }, null, 2));
  console.log('\nsaved to ./tmp/template-page-capture.json');

} finally {
  await browser.close();
}
