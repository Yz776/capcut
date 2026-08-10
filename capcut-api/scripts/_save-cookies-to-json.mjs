import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';

const userDataDir = path.resolve(process.cwd(), '.capcut-profile');
const cookieFile = path.join(userDataDir, 'cookies.json');

const browser = await puppeteer.launch({
  headless: 'new',
  userDataDir,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote'],
});

try {
  const page = await browser.newPage();
  await page.goto('https://www.capcut.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const cookies = await browser.cookies('https://www.capcut.com', 'https://capcut.com');
  fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
  console.log(`✓ Saved ${cookies.length} cookies to ${cookieFile}`);
  console.log('Cookie names:', cookies.map(c => c.name).join(', '));
} finally {
  await browser.close();
  await new Promise(r => setTimeout(r, 500));
}
