// scripts/validate-cookies.js
// Standalone cookie validator — runs in a child process spawned by manual-login.js
// 
// Input: cookies JSON via stdin (one of: array, {cookies:[...]}, header string, Netscape)
// Output: JSON result via stdout
// Exit: 0 on success (any validation result), non-zero on internal error
//
// Flow:
// 1. Read cookies JSON from stdin
// 2. Launch headless puppeteer with .capcut-profile userDataDir
// 3. setCookie() — overwrites/stores cookies in profile
// 4. Navigate to https://www.capcut.com/my-cloud/material (login-gated)
// 5. Check: were we redirected to /login? Is account content visible?
// 6. Print {ok: true/false, ...details} to stdout
// 7. Close browser, exit

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const userDataDir = path.resolve(projectRoot, '.capcut-profile');
const tmpDir = path.resolve(projectRoot, 'tmp');
const validationShotPath = path.join(tmpDir, 'login-validation.png');
fs.mkdirSync(tmpDir, { recursive: true });

// Clean up stale SingletonLock from previous crashed chrome instance
for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.rmSync(path.join(userDataDir, lockFile), { force: true }); } catch (_) {}
}

// ====== Cookie parser (same as manual-login.js) ======
function normalizeCookie(c) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').trim();
  const value = String(c.value ?? '').trim();
  if (!name) return null;
  let domain = String(c.domain || '.capcut.com').trim();
  if (!domain.startsWith('.') && !domain.startsWith('http')) domain = `.${domain}`;
  domain = domain.replace(/^https?:\/\//, '');
  let sameSite = (c.sameSite || 'lax').toString().toLowerCase();
  if (!['strict', 'lax', 'none'].includes(sameSite)) sameSite = 'lax';
  const cookie = {
    name, value, domain,
    path: c.path || '/',
    secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false,
    sameSite: sameSite.charAt(0).toUpperCase() + sameSite.slice(1),
  };
  if (c.expirationDate && Number.isFinite(c.expirationDate)) cookie.expires = c.expirationDate;
  else if (c.expires && Number.isFinite(c.expires)) cookie.expires = c.expires;
  return cookie;
}

function parseCookies(rawInput) {
  const input = rawInput.trim();
  if (!input) throw new Error('Empty input');

  if (input.startsWith('[') || input.startsWith('{')) {
    let data;
    try { data = JSON.parse(input); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
    let arr = null;
    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data.cookies)) arr = data.cookies;
    else if (typeof data === 'object') {
      const possibleCookies = Object.entries(data).filter(([, v]) => typeof v === 'string' || typeof v === 'number');
      if (possibleCookies.length > 0) {
        arr = possibleCookies.map(([name, value]) => ({ name, value: String(value), domain: '.capcut.com', path: '/' }));
      }
    }
    if (!arr || arr.length === 0) throw new Error('JSON did not contain any cookies');
    return arr.map(c => normalizeCookie(c)).filter(Boolean);
  }

  if (input.startsWith('#') || input.includes('\t')) {
    const lines = input.split(/\r?\n/);
    const cookies = [];
    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const [domain, , p, secure, expiration, name, value] = parts;
      cookies.push({
        name, value,
        domain: domain.startsWith('.') ? domain : `.${domain}`,
        path: p || '/', secure: secure === 'TRUE',
        expires: parseInt(expiration, 10) || undefined, httpOnly: false,
      });
    }
    if (cookies.length > 0) return cookies.map(normalizeCookie).filter(Boolean);
  }

  if (input.includes('=')) {
    const cookies = input.split(';').map(c => c.trim()).filter(Boolean).map(c => {
      const idx = c.indexOf('=');
      if (idx === -1) return null;
      return { name: c.slice(0, idx).trim(), value: c.slice(idx + 1).trim(), domain: '.capcut.com', path: '/' };
    }).filter(Boolean);
    if (cookies.length > 0) return cookies.map(normalizeCookie).filter(Boolean);
  }

  throw new Error('Could not parse input as JSON, Netscape, or cookie header format');
}

// ====== Main ======
async function main() {
  // Read cookies from stdin
  let rawInput = '';
  for await (const chunk of process.stdin) rawInput += chunk;

  if (!rawInput.trim()) {
    console.log(JSON.stringify({ ok: false, error: 'No input received on stdin' }));
    process.exit(2);
  }

  let cookies;
  try {
    cookies = parseCookies(rawInput);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `Parse error: ${e.message}` }));
    process.exit(2);
  }

  if (cookies.length === 0) {
    console.log(JSON.stringify({ ok: false, error: 'No cookies found in input' }));
    process.exit(2);
  }

  process.stderr.write(`[validate-cookies] Launching browser with ${cookies.length} cookies, profile=${userDataDir}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-gpu',
      '--mute-audio',
      '--window-size=1440,900',
    ],
  });

  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });
    await page.setViewport({ width: 1440, height: 900 });

    process.stderr.write(`[validate-cookies] Setting ${cookies.length} cookies on https://www.capcut.com/\n`);
    await page.setCookie(...cookies);

    process.stderr.write(`[validate-cookies] Navigating to https://www.capcut.com/my-cloud/material\n`);
    await page.goto('https://www.capcut.com/my-cloud/material', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await new Promise(r => setTimeout(r, 4000));

    const finalUrl = page.url();
    const title = await page.title().catch(() => '(no title)');
    process.stderr.write(`[validate-cookies] Final URL: ${finalUrl} (title: ${title})\n`);

    await page.screenshot({ path: validationShotPath, fullPage: false }).catch(() => {});

    const redirectedToLogin = /\/login(\?|$|\/)/.test(finalUrl);

    const probe = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').slice(0, 5000);
      const hasLoginText = /\bLog in\b|\bSign in\b|\bSign up\b|\b登入\b|\b登錄\b/.test(bodyText);
      const hasAccountText = /\bLog out\b|\bSign out\b|\bMy account\b|\bMy Cloud\b|\bMy materials\b|\bAccount settings\b/i.test(bodyText);
      const hasAvatar = !!document.querySelector(
        '[class*="avatar" i], [data-e2e*="user" i], [class*="user-info" i], [class*="header-user" i]'
      );
      const hasLoginButton = !!document.querySelector('a[href*="login" i]');
      return { hasLoginText, hasAccountText, hasAvatar, hasLoginButton, bodyTextLen: bodyText.length };
    }).catch(() => ({ hasLoginText: false, hasAccountText: false, hasAvatar: false, hasLoginButton: false, bodyTextLen: 0 }));

    const browserCookies = await browser.cookies('https://www.capcut.com').catch(() => []);
    const sessionCookies = browserCookies.filter(c =>
      /session|token|uid|passport|sid|s_v_web_id/i.test(c.name)
    );
    const hasPassport = sessionCookies.some(c => c.name.includes('passport'));
    const hasSessionId = sessionCookies.some(c => c.name === 'sessionid' || c.name === 'sessionid_ss');

    process.stderr.write(`[validate-cookies] Cookies in browser: total=${browserCookies.length}, session=${sessionCookies.length}, passport=${hasPassport}, sessionid=${hasSessionId}\n`);

    const username = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-e2e="user-name"], .user-name, .nickname, [class*="user-name" i], [class*="nickname" i]'
      );
      return el?.textContent?.trim() || null;
    }).catch(() => null);

    // Save cookies.json backup
    const cookiesJsonPath = path.resolve(projectRoot, 'cookies.json');
    fs.writeFileSync(cookiesJsonPath, JSON.stringify(cookies, null, 2));

    const verdict = (() => {
      if (redirectedToLogin) {
        return { ok: false, error: `Redirected to login page (${finalUrl}). Cookies are invalid or expired.` };
      }
      if (probe.hasLoginText && !probe.hasAccountText && !hasPassport) {
        return { ok: false, error: 'Login button visible, no passport cookie. Cookies missing or expired.' };
      }
      if (hasPassport && hasSessionId && (probe.hasAccountText || probe.hasAvatar || !probe.hasLoginText)) {
        return { ok: true, reason: 'Passport + sessionid cookies present, account content visible' };
      }
      if (hasPassport && !probe.hasLoginText) {
        return { ok: true, reason: 'Passport cookie present, no login button visible' };
      }
      if (probe.hasAccountText || probe.hasAvatar) {
        return { ok: true, reason: 'Account indicators found in DOM' };
      }
      if (probe.hasLoginText) {
        return { ok: false, error: 'Login text visible, account indicators absent. Login likely failed.' };
      }
      if (!redirectedToLogin && sessionCookies.length > 3) {
        return { ok: true, reason: `Not redirected, ${sessionCookies.length} session cookies set (ambiguous DOM)` };
      }
      return { ok: false, error: `Could not determine login state. URL: ${finalUrl}` };
    })();

    const result = {
      ...verdict,
      finalUrl,
      title,
      cookieCount: cookies.length,
      sessionCookieCount: sessionCookies.length,
      hasPassport,
      hasSessionId,
      username,
      probe,
      screenshotPath: validationShotPath,
    };

    process.stderr.write(`[validate-cookies] Verdict: ${verdict.ok ? 'OK' : 'FAIL'} — ${verdict.reason || verdict.error}\n`);

    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[validate-cookies] ERROR: ${e.message}\n${e.stack}\n`);
    console.log(JSON.stringify({ ok: false, error: `Validator error: ${e.message}` }));
    process.exit(1);
  } finally {
    try { await browser.close(); } catch (_) {}
    // Give chrome a moment to fully exit
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(e => {
  process.stderr.write(`[validate-cookies] FATAL: ${e.message}\n${e.stack}\n`);
  console.log(JSON.stringify({ ok: false, error: `Fatal: ${e.message}` }));
  process.exit(1);
});
