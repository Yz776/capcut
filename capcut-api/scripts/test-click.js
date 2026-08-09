// scripts/test-click.js - debug parent click strategy in isolation
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: { width: 1440, height: 900 },
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

const page = (await browser.pages())[0] || await browser.newPage();
await page.goto('https://www.capcut.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 4000));

// Cari span dengan text "Continue with email"
const pos = await page.evaluate(() => {
  const spans = document.querySelectorAll('span');
  for (const s of spans) {
    if (/continue with email/i.test(s.textContent || '')) {
      let target = s;
      const parents = [];
      for (let i = 0; i < 4; i++) {
        const p = target.parentElement;
        if (!p) break;
        const cls = p.className?.toString() || '';
        parents.push({ tag: p.tagName, class: cls.slice(0, 80) });
        target = p;
        if (/wrapper|container|clickable|expand/i.test(cls)) break;
      }
      const r = target.getBoundingClientRect();
      return {
        found: true,
        tag: target.tagName,
        class: target.className?.toString().slice(0, 100),
        text: target.textContent?.trim().slice(0, 60),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        parents,
      };
    }
  }
  return { found: false };
});
console.log('Result:', JSON.stringify(pos, null, 2));

if (pos.found && pos.rect.w > 0) {
  const cx = pos.rect.x + pos.rect.w / 2;
  const cy = pos.rect.y + pos.rect.h / 2;
  console.log('Clicking at', cx, cy);
  await page.mouse.move(cx, cy, { steps: 5 });
  await new Promise(r => setTimeout(r, 300));
  await page.mouse.click(cx, cy);
  await new Promise(r => setTimeout(r, 5000));

  const inputs = await page.$$('input');
  console.log('Inputs after click:', inputs.length);
  await page.screenshot({ path: '/home/z/my-project/capcut-api/tmp/after-click-debug.png' });
}

await browser.close();
