// scripts/inspect-template-detail.js
// Masuk ke 1 individual template, cek: butuh login? ada tombol use template?
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const TEMPLATE_URL = 'https://www.capcut.com/zh-tw/template-detail/foryou-trend-Viral/7492444922599968053';

try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log(`=== Going to ${TEMPLATE_URL} ===`);
  await page.goto(TEMPLATE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  console.log('Title:', await page.title());
  console.log('URL:', page.url());

  // Cari SEMUA button + link di area konten utama
  console.log('\n=== All buttons ===');
  const buttons = await page.$$eval('button', els => els.slice(0, 20).map(el => ({
    text: el.textContent?.trim().slice(0, 60),
    class: (el.className || '').slice(0, 80),
    dataTestId: el.getAttribute('data-testid'),
    ariaLabel: el.getAttribute('aria-label'),
  })));
  buttons.filter(b => b.text).forEach(b => console.log('  BTN:', JSON.stringify(b)));

  console.log('\n=== Links containing "use" / "edit" / "create" / "template" ===');
  const links = await page.$$eval('a[href]', els => els.map(el => ({
    href: el.getAttribute('href'),
    text: el.textContent?.trim().slice(0, 60),
  })));
  const relevant = links.filter(l => /use|edit|create|template|創建|編輯|套用|使用|建立/i.test(l.text + l.href));
  relevant.slice(0, 15).forEach(l => console.log('  ', l.href, '|', l.text));

  // Cek body text untuk kata kunci login/signup
  console.log('\n=== Login required indicators ===');
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const indicators = {
    loginRequired: /please (log|sign) in|login required|need to login|need to log in/i.test(bodyText),
    hasUseTemplate: /use template|use this template|套用|使用此|使用模板/i.test(bodyText),
    hasEditButton: /edit template|編輯/i.test(bodyText),
    hasDuration: /(\d+:\d+)/.test(bodyText),
    durationMatches: (bodyText.match(/\d+:\d+/g) || []).slice(0, 5),
  };
  console.log(JSON.stringify(indicators, null, 2));

  // Body snippet
  console.log('\n=== Body snippet (first 800 chars) ===');
  console.log(bodyText.slice(0, 800).replace(/\n+/g, ' | '));

  // Screenshot
  await page.screenshot({ path: '/home/z/my-project/capcut-api/tmp/capcut-template-detail.png', fullPage: false });
  console.log('\nScreenshot: /home/z/my-project/capcut-api/tmp/capcut-template-detail.png');

} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await browser.close();
}
