// scripts/verify-session.js
// Verifikasi apakah session CapCut di .capcut-profile masih valid.
// Jalankan: node scripts/verify-session.js
//
// Output: list cookies session yang ada + screenshot homepage untuk konfirmasi visual.

import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = process.env.CAPCUT_USER_DATA_DIR || path.resolve(projectRoot, '.capcut-profile');
const tmpDir = path.resolve(projectRoot, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const BASE_URL = process.env.CAPCUT_BASE_URL || 'https://www.capcut.com';

(async () => {
  console.log(`\n=== CapCut Session Verifier ===`);
  console.log(`userDataDir: ${userDataDir}`);
  console.log(`baseURL: ${BASE_URL}\n`);

  if (!fs.existsSync(userDataDir)) {
    console.error(`❌ userDataDir tidak ditemukan. Jalankan: npm run login:manual`);
    process.exit(1);
  }

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
      '--mute-audio',
    ],
  });

  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });
    await page.setViewport({ width: 1440, height: 900 });

    console.log('Opening CapCut homepage...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));

    const url = page.url();
    const title = await page.title();
    console.log(`\n  current URL : ${url}`);
    console.log(`  page title  : ${title}`);

    // Cek redirect ke login
    if (/\/login/.test(url)) {
      console.log('\n❌ Di-redirect ke /login → session EXPIRED');
      console.log('   Jalankan: npm run login:manual');
      await page.screenshot({ path: path.join(tmpDir, 'session-expired.png'), fullPage: false });
      process.exit(2);
    }

    // Cek cookies
    const cookies = await browser.cookies();
    const sessionCookies = cookies.filter(c =>
      /session|token|uid|passport|sid|s_v_web_id/i.test(c.name)
    );
    console.log(`\n  total cookies       : ${cookies.length}`);
    console.log(`  session cookies    : ${sessionCookies.length}`);
    if (sessionCookies.length > 0) {
      console.log('  session cookie names:');
      for (const c of sessionCookies.slice(0, 10)) {
        console.log(`    - ${c.name}  (domain=${c.domain}, expires=${c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session'})`);
      }
    }

    // Cek avatar/login indicator (multiple selectors)
    const avatarFound = await page.$('[class*="avatar" i], [data-testid*="user" i], [class*="user-info" i], [class*="header-user" i], [class*="account" i]');
    console.log(`\n  avatar element found : ${avatarFound ? 'YES ✅' : 'NO (mungkin selector beda)'}`);

    // Cek apakah ada tombol "Log in" (artinya belum login)
    // Note: jangan mix `:has-text()` dengan selector biasa di 1 string — Puppeteer PSelector parser bisa bermasalah.
    let loginBtn = await page.$('a[href*="login"]');
    if (!loginBtn) {
      try { loginBtn = await page.$('button:has-text("Log in")'); } catch (_) {}
    }
    console.log(`  login button visible : ${loginBtn ? 'YES (belum login)' : 'NO (sudah login) ✅'}`);

    // Cek via DOM text (lebih robust)
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    const hasLoginText = /\bLog in\b|\bSign in\b|\b登入\b|\b登錄\b/.test(bodyText);
    const hasUserInfo = /\bMy account\b|\bAccount\b|\bLog out\b|\b登出\b|\b个人中心\b/i.test(bodyText);
    console.log(`  body has "Log in" text : ${hasLoginText ? 'YES (belum login)' : 'NO ✅'}`);
    console.log(`  body has account text  : ${hasUserInfo ? 'YES (sudah login) ✅' : 'NO'}`);

    // Screenshot
    const ss = path.join(tmpDir, 'session-verify.png');
    await page.screenshot({ path: ss, fullPage: false });
    console.log(`\n  screenshot saved: ${ss}`);

    // Login decision tree:
    //  1. Kalau ada passport_csrf_token + tidak ada login text → login valid
    //  2. Kalau ada login text + tidak ada passport cookie → expired
    const hasPassportCookie = sessionCookies.some(c => c.name.includes('passport'));
    if (hasPassportCookie && !hasLoginText) {
      console.log('\n✅ Session VALID (passport cookie + tidak ada login button). Siap dipakai untuk render');
      process.exit(0);
    } else if (hasPassportCookie && hasLoginText) {
      console.log('\n⚠️  Passport cookie ada tapi login button masih muncul. Coba test API langsung.');
      process.exit(0);
    } else if (sessionCookies.length > 0) {
      console.log('\n⚠️  Session cookies ada tapi tidak ada passport cookie. Session mungkin tidak lengkap.');
      process.exit(0);
    } else {
      console.log('\n❌ Session EXPIRED — tidak ada cookie session');
      console.log('   Jalankan: npm run login:manual');
      process.exit(2);
    }
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
