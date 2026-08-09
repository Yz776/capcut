// scripts/inspect-dom.js
// Inspect CapCut /template page DOM lebih dalam untuk cari template link pattern
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('=== Going to https://www.capcut.com/template ===');
  await page.goto('https://www.capcut.com/template', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  // Scroll 3x untuk load lazy content
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await new Promise(r => setTimeout(r, 1500));
  }

  // Cari SEMUA link di halaman, group by pattern
  const allLinks = await page.$$eval('a', els => els.map(el => el.getAttribute('href') || '').filter(h => h));
  const patterns = {};
  for (const h of allLinks) {
    const m = h.match(/^(\/[a-z_-]+\/)/i);
    const key = m ? m[1] : h.split('?')[0].slice(0, 40);
    patterns[key] = (patterns[key] || 0) + 1;
  }
  console.log('\n=== Top 30 link patterns ===');
  Object.entries(patterns).sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, v]) => {
    console.log(`  ${v}x  ${k}`);
  });

  // Cari links yang mengandung "template" atau "detail" atau angka (kemungkinan ID)
  console.log('\n=== Links containing "template/detail/" ===');
  const detailLinks = allLinks.filter(h => /template\/detail/i.test(h));
  console.log(`Found: ${detailLinks.length}`);
  detailLinks.slice(0, 10).forEach(l => console.log('  ', l));

  console.log('\n=== Links containing template ID-like pattern ===');
  const idLinks = allLinks.filter(h => /template\/[\w-]{6,}/i.test(h));
  console.log(`Found: ${idLinks.length}`);
  idLinks.slice(0, 10).forEach(l => console.log('  ', l));

  // Cari elements yang clickable dengan role atau class template
  console.log('\n=== Elements with [class*=template] ===');
  const templateEls = await page.$$eval('[class*="template" i], [class*="card" i]', els => els.slice(0, 5).map(el => ({
    tag: el.tagName,
    class: el.className.slice(0, 100),
    text: el.textContent?.trim().slice(0, 80),
    href: el.getAttribute('href'),
    onclick: el.getAttribute('onclick'),
    dataTestId: el.getAttribute('data-testid'),
  })));
  console.log(JSON.stringify(templateEls, null, 2));

  // Cek body inner text untuk lihat kata kunci login
  console.log('\n=== Header area text ===');
  const headerText = await page.evaluate(() => {
    const headers = document.querySelectorAll('header, [class*="header" i], [class*="nav" i]');
    return Array.from(headers).slice(0, 2).map(h => h.textContent?.trim().slice(0, 300));
  });
  console.log(JSON.stringify(headerText, null, 2));

  // Cari tombol login / signup
  console.log('\n=== Login-related elements ===');
  const loginEls = await page.$$eval('button, a', els => els.filter(el => {
    const t = (el.textContent || '').trim().toLowerCase();
    return /log ?in|sign ?in|登录|登入|登錄|登陆/.test(t);
  }).map(el => ({
    tag: el.tagName,
    text: el.textContent?.trim().slice(0, 50),
    class: (el.className || '').slice(0, 80),
    href: el.getAttribute('href'),
  })));
  console.log(JSON.stringify(loginEls.slice(0, 5), null, 2));

} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await browser.close();
}
