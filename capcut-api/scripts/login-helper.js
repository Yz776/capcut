// scripts/login-helper.js
// Connect to running browser via CDP for inspection & interaction.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const browser = await puppeteer.connect({
  browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser',
  defaultViewport: null,
});

const pages = await browser.pages();
const page = pages.find(p => p.url().includes('capcut.com')) || pages[0];

const cmd = process.argv[2];
console.log(`URL: ${page.url()}`);
console.log(`Cmd: ${cmd}\n`);

switch (cmd) {
  case 'inspect': {
    const buttons = await page.$$eval('button, a, div[role="button"]', els =>
      els.slice(0, 50).map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim().slice(0, 80),
        class: (el.className || '').toString().slice(0, 80),
        href: el.getAttribute('href'),
        visible: el.offsetParent !== null,
      })).filter(b => b.text && b.visible && b.text.length < 80)
    );
    buttons.forEach((b, i) => console.log(`[${i}] ${b.tag} "${b.text}"`));
    break;
  }

  case 'click-text': {
    const target = process.argv[3];
    if (!target) { console.error('Text required'); process.exit(1); }
    console.log(`Looking for text: "${target}"`);
    const clicked = await page.evaluate((t) => {
      const els = document.querySelectorAll('button, a, div[role="button"], div[tabindex], span');
      for (const el of els) {
        const ownText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        const allText = el.textContent?.trim() || '';
        if ((ownText === t || allText === t) && allText.length < 80) {
          el.click();
          return { text: allText, tag: el.tagName, class: el.className?.toString().slice(0, 60) };
        }
      }
      return null;
    }, target);
    console.log('Clicked:', clicked);
    await new Promise(r => setTimeout(r, 4000));
    break;
  }

  case 'screenshot': {
    const name = process.argv[3] || 'state';
    const p = `/home/z/my-project/capcut-api/tmp/login-${name}.png`;
    await page.screenshot({ path: p, fullPage: false });
    console.log('Saved:', p);
    break;
  }

  case 'state': {
    const avatar = await page.$('[class*="avatar" i], [data-testid*="user" i]');
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1000) || '');
    console.log('URL:', page.url());
    console.log('Logged in:', !!avatar);
    console.log('\nBody text:\n', bodyText.slice(0, 800).replace(/\n+/g, '\n'));
    break;
  }

  case 'dom': {
    // Dump struktur DOM lengkap di area login
    const html = await page.evaluate(() => {
      const main = document.querySelector('main, [class*="login" i], [class*="auth" i], [class*="modal" i]') || document.body;
      return main.outerHTML.slice(0, 5000);
    });
    console.log(html);
    break;
  }

  case 'fill': {
    const selector = process.argv[3];
    const value = process.argv[4];
    if (!selector || !value) { console.error('Usage: fill <selector> <value>'); process.exit(1); }
    const el = await page.$(selector);
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(value, { delay: 30 });
      console.log('Filled.');
    } else {
      console.log('Element not found:', selector);
    }
    break;
  }

  case 'eval': {
    const code = process.argv[3];
    if (!code) { console.error('Code required'); process.exit(1); }
    const r = await page.evaluate(code);
    console.log(JSON.stringify(r, null, 2));
    break;
  }

  default:
    console.log('Commands: inspect, click-text <text>, screenshot <name>, state, dom, fill <sel> <val>, eval <code>');
}

await browser.disconnect();
