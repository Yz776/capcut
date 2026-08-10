import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  const cookies = await browser.cookies('https://www.capcut.com', 'https://capcut.com');
  
  // Check critical login cookies
  const critical = ['sessionid', 'passport_csrf_token', 'passport', 'ttwid', 'sid_tt', 'uid_tt', 'ssid_tt', 's_v_web_id'];
  console.log('\n=== Critical cookies ===');
  for (const name of critical) {
    const c = cookies.find(c => c.name === name);
    if (c) {
      const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session';
      console.log(`  ${name}: expires=${exp}, length=${c.value.length}, domain=${c.domain}`);
    } else {
      console.log(`  ${name}: MISSING ❌`);
    }
  }
  
  // Try to fetch user info to verify session
  console.log('\n=== Verify session via API ===');
  const result = await page.evaluate(async () => {
    try {
      const r = await fetch('https://www.capcut.com/passport/web/account/info/', {
        credentials: 'include',
      });
      return { status: r.status, data: await r.text() };
    } catch (e) { return { error: e.message }; }
  });
  console.log('  status:', result.status);
  console.log('  data:', (result.data || '').slice(0, 300));
} finally {
  await browser.close();
}
