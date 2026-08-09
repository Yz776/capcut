// scripts/test-use-template.js
// Klik "使用這個範本" (Use this template), lihat redirect ke login atau editor
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
  await new Promise(r => setTimeout(r, 4000));

  // Cari elemen yang mengandung text "使用這個範本"
  console.log('=== Find "使用這個範本" element ===');
  const useTemplateInfo = await page.evaluate(() => {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const ownText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      if (/使用這個範本|use this template/i.test(ownText)) {
        return {
          tag: el.tagName,
          class: el.className?.toString().slice(0, 100),
          text: el.textContent?.trim().slice(0, 80),
          parentTag: el.parentElement?.tagName,
          parentClass: el.parentElement?.className?.toString().slice(0, 100),
          href: el.getAttribute('href') || el.parentElement?.getAttribute('href'),
          role: el.getAttribute('role'),
          onclick: el.getAttribute('onclick'),
          outerHTML: el.outerHTML.slice(0, 300),
        };
      }
    }
    return null;
  });
  console.log(JSON.stringify(useTemplateInfo, null, 2));

  // Klik elemennya
  if (useTemplateInfo) {
    console.log('\n=== Clicking "使用這個範本" ===');
    const selector = `${useTemplateInfo.tag}.${useTemplateInfo.class?.split(' ')[0]}`.replace(/\.$/, '');
    console.log('Selector:', selector);

    // Intercept new tabs / navigations
    const navPromises = [];
    page.on('request', (req) => {
      if (req.isNavigationRequest() && req.url() !== TEMPLATE_URL) {
        navPromises.push({ url: req.url(), type: req.resourceType() });
      }
    });

    try {
      // Coba klik langsung pada text element
      const clicked = await page.evaluate(() => {
        const allEls = document.querySelectorAll('*');
        for (const el of allEls) {
          const ownText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
          if (/使用這個範本|use this template/i.test(ownText)) {
            el.click();
            return true;
          }
        }
        return false;
      });
      console.log('Clicked:', clicked);

      // Tunggu navigasi atau popup
      await new Promise(r => setTimeout(r, 8000));
      console.log('Current URL after click:', page.url());
      console.log('Number of pages/tabs:', (await browser.pages()).length);
      const allPages = await browser.pages();
      for (let i = 0; i < allPages.length; i++) {
        console.log(`  Tab ${i}: ${allPages[i].url()}`);
      }
      console.log('Navigation requests intercepted:', navPromises.length);
      navPromises.slice(0, 5).forEach(n => console.log('  →', n.url));

      // Screenshot halaman setelah klik
      await page.screenshot({ path: '/home/z/my-project/capcut-api/tmp/after-click.png', fullPage: false });
      console.log('Screenshot: tmp/after-click.png');

      // Body text setelah klik
      const bodyAfter = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
      console.log('\nBody after click (first 400 chars):');
      console.log(bodyAfter.slice(0, 400).replace(/\n+/g, ' | '));

    } catch (e) {
      console.error('Click failed:', e.message);
    }
  }

} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await browser.close();
}
