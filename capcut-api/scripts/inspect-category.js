// scripts/inspect-category.js
// Masuk ke kategori template, cari individual template URL pattern
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('=== Going to https://www.capcut.com/zh-tw/template/social ===');
  await page.goto('https://www.capcut.com/zh-tw/template/social', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));

  // Scroll untuk trigger lazy load
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await new Promise(r => setTimeout(r, 1500));
  }

  // Ambil SEMUA link, filter yang ada di area konten (bukan header/footer)
  const allLinks = await page.$$eval('a[href]', els => els.map(el => ({
    href: el.getAttribute('href'),
    text: el.textContent?.trim().slice(0, 50),
  })));

  console.log(`Total links: ${allLinks.length}`);

  // Filter link yang mengandung template + sesuatu setelahnya
  const templateLinks = allLinks.filter(l => /\/template\/[^/?#]+/.test(l.href) && !/\/template\/(social|holiday|calendar|anniversary|effects|business|industry|record|hot|search|info|recommend)/i.test(l.href));
  console.log(`\nTemplate links (non-category): ${templateLinks.length}`);
  templateLinks.slice(0, 15).forEach(l => console.log('  ', l.href, '|', l.text));

  // Cari element <a> dengan class thumbnail/img - kemungkinan individual template
  console.log('\n=== Links with images inside ===');
  const imgLinks = await page.$$eval('a[href] img', els => els.slice(0, 10).map(el => {
    const parent = el.closest('a');
    return {
      href: parent?.getAttribute('href'),
      imgSrc: (el.getAttribute('src') || '').slice(0, 80),
      imgAlt: el.getAttribute('alt')?.slice(0, 50),
    };
  }));
  imgLinks.forEach(l => console.log('  ', l.href, '|', l.imgSrc, '|', l.imgAlt));

  // Screenshot
  await page.screenshot({ path: '/home/z/my-project/capcut-api/tmp/capcut-category.png', fullPage: false });
  console.log('\nScreenshot: /home/z/my-project/capcut-api/tmp/capcut-category.png');

} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await browser.close();
}
