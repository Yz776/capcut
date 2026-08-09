// scripts/test-browser.js
// Test: apakah Chromium bisa launch & CapCut accessible di env ini?
import puppeteer from 'puppeteer';
import { config } from '../src/utils/config.js';

console.log('=== TEST 1: Launch Chromium & Access CapCut ===\n');
console.log('Launching Chromium headless...');
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating to https://www.capcut.com ...');
  await page.goto('https://www.capcut.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('Page title:', await page.title());
  console.log('Page URL:', page.url());

  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || 'NO BODY');
  console.log('Body snippet:', bodyText.slice(0, 300).replace(/\n+/g, ' | '));

  const hasCaptcha = await page.evaluate(() => {
    const txt = document.body?.innerText || '';
    return /captcha|verify|robot|human|blocked|access denied|unusual traffic/i.test(txt);
  });
  console.log('Captcha/Block detected:', hasCaptcha);

  console.log('\n=== TEST 2: Navigate to /templates ===');
  await page.goto('https://www.capcut.com/templates', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));
  console.log('Title:', await page.title());
  console.log('URL:', page.url());

  // Cari link template
  const templateLinks = await page.$$eval('a[href*="/templates/detail/"]', els => els.slice(0, 5).map(el => ({
    href: el.getAttribute('href'),
    text: el.textContent?.trim().slice(0, 60),
  })));
  console.log('Template links found:', templateLinks.length);
  console.log(JSON.stringify(templateLinks, null, 2));

  // Cek apakah perlu login untuk lihat templates
  const loginRequired = await page.evaluate(() => {
    const txt = document.body?.innerText || '';
    return /log in|sign in|please login/i.test(txt.slice(0, 2000));
  });
  console.log('Login required to view templates?:', loginRequired);

  // Screenshot untuk lihat apa yang sebenarnya terjadi
  await page.screenshot({ path: '/home/z/my-project/capcut-api/tmp/capcut-templates.png', fullPage: false });
  console.log('Screenshot saved: /home/z/my-project/capcut-api/tmp/capcut-templates.png');

} catch (e) {
  console.error('ERROR:', e.message);
  console.error(e.stack);
} finally {
  await browser.close();
  console.log('\nBrowser closed.');
}
