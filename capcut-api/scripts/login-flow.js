// scripts/login-flow.js (full email+password login)
// Usage:
//   DISPLAY=:99 node scripts/login-flow.js
//   atau: DISPLAY=:99 node scripts/login-flow.js email@example.com mypassword
//   atau: CAPCUT_EMAIL=... CAPCUT_PASSWORD=... DISPLAY=:99 node scripts/login-flow.js
//
// Flow:
//   1. Open https://www.capcut.com/login
//   2. Click "Continue with email" via mouse.click (real mouse events)
//   3. Fill email
//   4. Click Continue/Next
//   5. Fill password
//   6. Click Login
//   7. Detect login success (avatar muncul)
//   8. Save session to userDataDir
//
// Jika ada captcha, screenshot akan disimpan ke tmp/captcha.png dan script exit.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const userDataDir = '/home/z/my-project/capcut-api/.capcut-profile';
const shotsDir = '/home/z/my-project/capcut-api/tmp/login-shots';
fs.mkdirSync(shotsDir, { recursive: true });

const email = process.argv[2] || process.env.CAPCUT_EMAIL;
const password = process.argv[3] || process.env.CAPCUT_PASSWORD;

if (!email || !password) {
  console.error('Usage: node scripts/login-flow.js <email> <password>');
  console.error('   or: CAPCUT_EMAIL=... CAPCUT_PASSWORD=... node scripts/login-flow.js');
  process.exit(1);
}

console.log(`[INIT] Email: ${email}`);
console.log(`[INIT] Password: ${'*'.repeat(password.length)}`);

const browser = await puppeteer.launch({
  headless: false,
  userDataDir,
  defaultViewport: { width: 1440, height: 900 },
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu', '--disable-software-rasterizer',
    '--remote-debugging-port=9222',
    '--window-size=1440,900',
  ],
});

browser.on('disconnected', () => {
  console.log('[FATAL] Browser disconnected');
  process.exit(2);
});

const pages = await browser.pages();
const page = pages[0] || await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0');

async function clickElementByText(selector, textRegexSource) {
  // Dapatkan posisi parent clickable (div container) yang berisi text.
  const pos = await page.evaluate((sel, reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const els = document.querySelectorAll(sel);
    const allMatches = [];
    let bestMatch = null;
    let bestMatchArea = 0;

    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (!re.test(t) || t.length >= 80) continue;

      // Naik ke parent sampai dapat container button-like
      let target = el;
      for (let i = 0; i < 5; i++) {
        const parent = target.parentElement;
        if (!parent) break;
        const parentClass = parent.className?.toString() || '';
        const parentTag = parent.tagName;
        const parentRect = parent.getBoundingClientRect();
        if (parentRect.width > 600 || parentRect.height > 200) break;
        target = parent;
        if (/button|wrapper|container|clickable|expand|action/i.test(parentClass) && parentTag === 'DIV') break;
      }

      const r = target.getBoundingClientRect();
      const area = r.width * r.height;
      allMatches.push({ text: t, tag: target.tagName, class: target.className?.toString().slice(0, 80), w: r.width, h: r.height, area });

      // Filter: skip terlalu kecil (label) atau terlalu besar (page container).
      // CapCut button class: lv_*-button, lv_*-wrapper, lv_email_entry_view-content
      // Tinggi: 30-200px, lebar: 50-500px
      if (r.width > 0 && r.height > 0 && r.height >= 25 && r.height <= 250 && r.width <= 500 && area > bestMatchArea) {
        bestMatch = { x: r.x + r.width/2, y: r.y + r.height/2, text: t, tag: target.tagName, class: target.className?.toString().slice(0, 100) };
        bestMatchArea = area;
      }
    }
    return { bestMatch, allMatches: allMatches.slice(0, 10) };
  }, selector, textRegexSource);
  if (!pos || !pos.bestMatch) {
    console.log('   No match. All candidates found:', JSON.stringify(pos?.allMatches || [], null, 2));
    return null;
  }
  const m = pos.bestMatch;
  console.log('   Click target:', m.tag, '"', m.text, '"', 'class:', m.class);
  await page.mouse.move(m.x, m.y, { steps: 5 });
  await new Promise(r => setTimeout(r, 300));
  await page.mouse.click(m.x, m.y);
  return m;
}

console.log('\n[1] Open https://www.capcut.com/login');
await page.goto('https://www.capcut.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 4000));

console.log('[2] Click "Continue with email"');
const r2 = await clickElementByText('span, button, a', 'continue with email');
console.log('   Clicked at:', r2);
await new Promise(r => setTimeout(r, 4000));
await page.screenshot({ path: path.join(shotsDir, '01-after-email-click.png'), fullPage: false });

console.log('\n[3] Fill email input');
const emailInput = await page.$('input[type="email"], input[name="username"], input[placeholder*="mail" i]');
if (!emailInput) {
  await page.screenshot({ path: path.join(shotsDir, 'FATAL-no-email-input.png'), fullPage: false });
  console.error('Email input not found!');
  await browser.close();
  process.exit(1);
}
await emailInput.click({ clickCount: 3 });
await emailInput.type(email, { delay: 50 });
console.log('   Email filled.');
await new Promise(r => setTimeout(r, 1000));
await page.screenshot({ path: path.join(shotsDir, '02-email-filled.png'), fullPage: false });

console.log('\n[4] Submit email form');
// Strategi: Enter key di email input biasanya trigger form submit di React form
await emailInput.focus();
await page.keyboard.press('Enter');
console.log('   Pressed Enter on email input.');
await new Promise(r => setTimeout(r, 4000));

// Coba juga click button "Continue" via mouse (kalau Enter tidak work)
const r4 = await clickElementByText('span, button, div', '^(continue|next)$');
console.log('   Click target:', r4);
await new Promise(r => setTimeout(r, 4000));
await page.screenshot({ path: path.join(shotsDir, '03-after-continue.png'), fullPage: false });

// Cek captcha
const bodyText = await page.evaluate(() => document.body?.innerText || '');
const captchaPatterns = [/captcha/i, /verify it/i, /verification/i, /robot/i, /滑块/i, /拼图/i, /puzzle/i, /not a robot/i, /please verify/i];
const foundCaptcha = captchaPatterns.find(p => p.test(bodyText));
if (foundCaptcha) {
  console.log('\n[!] CAPTCHA/VERIFICATION DETECTED!');
  console.log('    Pattern matched:', foundCaptcha);
  await page.screenshot({ path: '/home/z/my-project/capcut-api/tmp/captcha.png', fullPage: false });
  console.log('    Screenshot saved: tmp/captcha.png');
  console.log('    CapCut requires human verification. Login flow aborted.');
  await browser.close();
  process.exit(3);
}

console.log('\n[5] Look for password input');
const pwInput = await page.$('input[type="password"], input[name="password"]');
if (!pwInput) {
  console.log('   Password input not found. Page state:');
  console.log('   URL:', page.url());
  console.log('   Body text snippet:', bodyText.slice(0, 500).replace(/\n+/g, ' | '));
  await browser.close();
  process.exit(1);
}

console.log('[6] Fill password');
await pwInput.click({ clickCount: 3 });
await pwInput.type(password, { delay: 50 });
console.log('   Password filled.');
await new Promise(r => setTimeout(r, 1000));
await page.screenshot({ path: path.join(shotsDir, '04-password-filled.png'), fullPage: false });

console.log('\n[7] Click "Log in" / "Sign in"');
const r7 = await clickElementByText('button, div[role="button"], span', '^(log in|sign in|login|signin|登入|登錄|登录)$');
console.log('   Clicked at:', r7);

// Tunggu redirect / login
console.log('\n[8] Waiting for login success...');
let loginSuccess = false;
for (let i = 0; i < 30; i++) {  // 30 attempts * 2s = 60s max
  await new Promise(r => setTimeout(r, 2000));
  const avatar = await page.$('[class*="avatar" i], [data-testid*="user" i]').catch(() => null);
  if (avatar) {
    loginSuccess = true;
    break;
  }
  if (i % 5 === 0) {
    const elapsed = i * 2;
    console.log(`   [${elapsed}s] Waiting... URL: ${page.url()}`);
  }
}

if (loginSuccess) {
  console.log('\n[SUCCESS] Login detected!');
  await new Promise(r => setTimeout(r, 2000));
  await browser.close();
  console.log('Session saved to', userDataDir);
  process.exit(0);
} else {
  console.log('\n[FAIL] Login not detected after 60s');
  await page.screenshot({ path: path.join(shotsDir, 'FINAL-login-failed.png'), fullPage: false });
  const finalText = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || '');
  console.log('Final body text:', finalText.replace(/\n+/g, ' | ').slice(0, 400));
  await browser.close();
  process.exit(1);
}
