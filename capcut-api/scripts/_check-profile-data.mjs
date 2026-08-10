import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';

const projectRoot = '/home/z/my-project/capcut-api';
const userDataDir = path.join(projectRoot, '.capcut-profile');

const browser = await puppeteer.launch({
  headless: 'new',
  userDataDir,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.goto('https://www.capcut.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  // Check localStorage
  const ls = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out[k] = localStorage.getItem(k);
    }
    return out;
  });
  console.log('=== localStorage keys ===');
  for (const k of Object.keys(ls)) {
    const v = String(ls[k]);
    console.log(`  ${k}: ${v.length > 100 ? v.slice(0, 100) + '...' : v}`);
  }
  
  // Check IndexedDB databases
  const dbs = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    return dbs.map(d => ({name: d.name, version: d.version}));
  });
  console.log('\n=== IndexedDB databases ===');
  for (const d of dbs) console.log(`  ${d.name} (v${d.version})`);
  
  // Check all cookies including all domains
  const cookies = await browser.cookies('https://capcut.com', 'https://www.capcut.com', 'https://edit-api-sg.capcut.com');
  console.log(`\n=== All cookies (${cookies.length}) ===`);
  for (const c of cookies) {
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : 'session';
    console.log(`  ${c.name} (domain=${c.domain}, exp=${exp}, len=${c.value.length})`);
  }
} finally {
  await browser.close();
}
