// src/routes/login.js
//
// Cookie-paste login endpoint.
//
// Setelah session CapCut expired (ret=1015 notLogin), user dapat me-refresh session
// dengan paste cookies fresh dari browser. Endpoint ini akan:
//   1. Parse cookies (JSON array / header string / Netscape format)
//   2. Set cookies ke .capcut-profile via puppeteer
//   3. Verify session dengan hit /passport/web/account/info/
//   4. Return status login
//
// Cara pakai:
//   1. Buka https://www.capcut.com di browser, login normal
//   2. Buka DevTools → Application → Cookies → export semua cookies capcut.com
//   3. POST ke /login dengan body:
//      { "cookies": [...] }  // array of {name, value, domain, path, ...}
//      atau
//      { "cookieHeader": "name1=val1; name2=val2; ..." }
//      atau
//      { "netscape": "# Netscape HTTP Cookie File\n.capcut.com\tTRUE\t/\tFALSE\t...\tsessionid\t..." }
//   4. Atau buka http://localhost:7000/login di browser untuk form HTML

import { Hono } from 'hono';
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import axios from 'axios';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { loadCookies, saveCookiesToJson, invalidateCache, getCacheInfo } from '../utils/cookie-loader.js';

const app = new Hono();

const userDataDir = config.browser.userDataDir ||
  path.resolve(config.projectRoot, '.capcut-profile');

// ====== Cookie parser ======
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

function parseCookieInput(input) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const text = raw.trim();
  if (!text) throw new Error('Empty cookie input');

  // JSON array / object
  if (text.startsWith('[') || text.startsWith('{')) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
    let arr = null;
    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data.cookies)) arr = data.cookies;
    else if (typeof data === 'object') {
      // Object map: {name: value, ...}
      const possible = Object.entries(data).filter(([, v]) => typeof v === 'string' || typeof v === 'number');
      if (possible.length > 0) {
        arr = possible.map(([name, value]) => ({
          name, value: String(value), domain: '.capcut.com', path: '/',
        }));
      }
    }
    if (!arr || arr.length === 0) throw new Error('JSON did not contain any cookies');
    return arr.map(c => normalizeCookie(c)).filter(Boolean);
  }

  // Cookie header string: "name1=val1; name2=val2"
  if (text.includes('=') && (text.includes(';') || text.includes(','))) {
    const parts = text.split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const arr = [];
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name) arr.push({ name, value, domain: '.capcut.com', path: '/' });
    }
    if (arr.length === 0) throw new Error('Cookie header has no valid name=value pairs');
    return arr.map(c => normalizeCookie(c)).filter(Boolean);
  }

  // Netscape format
  if (text.startsWith('#') || text.includes('\t')) {
    const lines = text.split(/\r?\n/);
    const cookies = [];
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const [domain, flag, path, secure, expires, name, value] = parts;
      cookies.push({
        name, value, domain: domain.startsWith('.') ? domain : `.${domain}`,
        path: path || '/', secure: secure === 'TRUE',
        expirationDate: parseFloat(expires) || undefined,
      });
    }
    if (cookies.length === 0) throw new Error('Netscape format had no valid cookies');
    return cookies.map(c => normalizeCookie(c)).filter(Boolean);
  }

  throw new Error('Unrecognized cookie format. Use JSON array, cookie header string, or Netscape format.');
}

// ====== HTML form ======
const LOGIN_FORM_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CapCut API - Login</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         max-width: 800px; margin: 40px auto; padding: 20px; color: #1a1a1a; background: #fafafa; }
  h1 { color: #00c4cc; margin-bottom: 8px; }
  h2 { margin-top: 32px; font-size: 18px; }
  p, li { line-height: 1.6; }
  code { background: #eef; padding: 2px 6px; border-radius: 3px; font-family: ui-monospace, monospace; }
  pre { background: #1a1a2e; color: #eef; padding: 16px; border-radius: 8px; overflow-x: auto; }
  textarea { width: 100%; min-height: 180px; padding: 12px; border: 1px solid #ccc; border-radius: 6px;
             font-family: ui-monospace, monospace; font-size: 13px; }
  button { background: #00c4cc; color: white; border: none; padding: 12px 24px; border-radius: 6px;
           font-size: 16px; cursor: pointer; margin-top: 12px; }
  button:hover { background: #00a8b3; }
  .status { padding: 16px; border-radius: 6px; margin-top: 16px; }
  .status.ok { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
  .status.err { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
  .step { background: white; padding: 16px; border-radius: 6px; margin: 12px 0; border: 1px solid #eee; }
  .step h3 { margin: 0 0 8px 0; color: #00c4cc; font-size: 15px; }
</style>
</head>
<body>
<h1>CapCut API Login</h1>
<p>Paste cookies dari browser untuk refresh session.</p>

<div class="step">
  <h3>Cara dapat cookies:</h3>
  <ol>
    <li>Buka <a href="https://www.capcut.com" target="_blank">https://www.capcut.com</a> di browser &amp; login normal</li>
    <li>Buka DevTools (F12) → Application → Cookies → <code>https://www.capcut.com</code></li>
    <li>Pakai extension seperti <strong>EditThisCookie</strong> / <strong>Cookie-Editor</strong> untuk export semua cookies sebagai JSON</li>
    <li>Paste hasilnya di textarea bawah ini</li>
  </ol>
  <p>Atau, di browser console setelah login: <code>document.cookie</code> → copy string-nya.</p>
</div>

<form id="loginForm">
  <textarea id="cookies" placeholder='Paste cookies di sini. Format yang diterima:
- JSON array: [{"name":"sessionid","value":"...","domain":".capcut.com"}, ...]
- Cookie header: "sessionid=xxx; passport=yyy; ..."
- Netscape format'></textarea>
  <br>
  <button type="submit">Login</button>
</form>

<div id="result"></div>

<h2>Status Session Saat Ini</h2>
<button id="checkBtn">Check Session</button>
<div id="sessionStatus"></div>

<script>
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cookies = document.getElementById('cookies').value;
  const result = document.getElementById('result');
  result.innerHTML = '<p>Validating...</p>';
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ cookies }),
    });
    const data = await res.json();
    if (data.ok) {
      result.innerHTML = '<div class="status ok"><strong>✓ Login berhasil!</strong><br>' +
        'Cookies disimpan: ' + data.cookieCount + '<br>' +
        'User ID: ' + (data.userId || 'N/A') + '<br>' +
        'Session akan valid selama cookies belum expired.</div>';
    } else {
      result.innerHTML = '<div class="status err"><strong>✗ Login gagal:</strong><br>' +
        (data.error || 'Unknown error') + '</div>';
    }
  } catch (err) {
    result.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
  }
});

document.getElementById('checkBtn').addEventListener('click', async () => {
  const ss = document.getElementById('sessionStatus');
  ss.innerHTML = '<p>Checking...</p>';
  try {
    const res = await fetch('/login/status');
    const data = await res.json();
    if (data.loggedIn) {
      ss.innerHTML = '<div class="status ok"><strong>✓ Session valid</strong><br>' +
        'User: ' + (data.userId || 'unknown') + '<br>' +
        'Cookies: ' + data.cookieCount + '<br>' +
        'Critical: ' + data.critical.join(', ') + '</div>';
    } else {
      ss.innerHTML = '<div class="status err"><strong>✗ Session invalid / expired</strong><br>' +
        (data.error || 'Not logged in') + '<br>' +
        'Missing: ' + (data.missing || []).join(', ') + '</div>';
    }
  } catch (err) {
    ss.innerHTML = '<div class="status err">Error: ' + err.message + '</div>';
  }
});
</script>
</body>
</html>`;

// ====== Routes ======

/**
 * GET /login — HTML form for cookie paste
 */
app.get('/', (c) => c.html(LOGIN_FORM_HTML));

/**
 * GET /login/status — check current session status
 *
 * Uses shared cached cookies (no puppeteer spawn on every call). Cookies are loaded once
 * and cached for 5 minutes. Pass ?refresh=1 to force reload.
 */
app.get('/status', async (c) => {
  try {
    const refresh = c.req.query('refresh') === '1';
    const cookieData = await loadCookies(refresh);
    const cookies = cookieData.all;

    // Verify session by hitting /passport/web/account/info/ via axios (no browser needed)
    const infoResp = await axios.get('https://www.capcut.com/passport/web/account/info/', {
      headers: {
        Cookie: cookieData.header,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.capcut.com/',
      },
      timeout: 10000,
    });

    const critical = ['sessionid', 'passport_csrf_token', 'passport', 'sid_tt', 'ttwid'];
    const present = critical.filter(name => cookies.some(c => c.name === name));
    const missing = critical.filter(name => !cookies.some(c => c.name === name));

    const accountData = infoResp.data?.data;
    const hasUser = accountData?.user && !accountData?.error_code && !accountData?.description?.includes('expired');
    const loggedIn = !!hasUser;
    const userId = accountData?.user?.uid || accountData?.user?.user_id || null;

    const cacheInfo = getCacheInfo();
    return c.json({
      loggedIn,
      userId,
      cookieCount: cookies.length,
      critical: present,
      missing,
      error: loggedIn ? null : (accountData?.description || 'Session expired or not logged in'),
      accountInfo: accountData,
      cached: cacheInfo.cached,
      cacheAgeSec: cacheInfo.cached ? Math.floor(cacheInfo.ageMs / 1000) : 0,
      cacheExpiresSec: cacheInfo.cached ? Math.floor(cacheInfo.expiresMs / 1000) : 0,
    });
  } catch (e) {
    return c.json({ loggedIn: false, error: e.message }, 500);
  }
});

/**
 * POST /login — accept cookies and store in profile
 *
 * Body:
 *   { "cookies": [...] }              // JSON array
 *   { "cookieHeader": "a=1; b=2" }    // header string
 *   { "netscape": "..." }             // Netscape format
 *   { "raw": "..." }                  // auto-detect
 */
app.post('/', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ ok: false, error: 'Invalid JSON body: ' + e.message }, 400);
  }

  let cookieInput = body.cookies || body.cookieHeader || body.netscape || body.raw;
  if (!cookieInput) {
    return c.json({ ok: false, error: 'No cookies provided. Send {cookies: [...]}, {cookieHeader: "..."}, {netscape: "..."}, or {raw: "..."}' }, 400);
  }

  let cookies;
  try {
    cookies = parseCookieInput(cookieInput);
  } catch (e) {
    return c.json({ ok: false, error: 'Cookie parse failed: ' + e.message }, 400);
  }

  if (cookies.length === 0) {
    return c.json({ ok: false, error: 'No valid cookies after parsing' }, 400);
  }

  logger.info({ cookieCount: cookies.length, names: cookies.map(c => c.name).slice(0, 10) }, 'Login: parsed cookies');

  // Cleanup stale locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(userDataDir, lock), { force: true }); } catch {}
  }

  let browser;
  try {
    // Save cookies to cookies.json FIRST (fast, no puppeteer, used by all services)
    saveCookiesToJson(cookies);

    // Also save to .capcut-profile (for browser-editor render flow which uses puppeteer)
    browser = await puppeteer.launch({
      headless: 'new',
      userDataDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote',
      ],
    });

    const page = await browser.newPage();
    // Navigate first so domain is set, then set cookies
    await page.goto('https://www.capcut.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Set cookies via puppeteer (persists to .capcut-profile for future browser sessions)
    await browser.setCookie(...cookies);
    logger.info({ count: cookies.length }, 'Login: cookies set in profile & cookies.json');

    // Verify by hitting account info via axios (no need for browser)
    await page.goto('https://www.capcut.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const infoResp = await page.evaluate(async () => {
      try {
        const r = await fetch('https://www.capcut.com/passport/web/account/info/', { credentials: 'include' });
        return { status: r.status, data: await r.json() };
      } catch (e) { return { error: e.message }; }
    });

    const accountData = infoResp.data?.data;
    const hasUser = accountData?.user && !accountData?.error_code && !accountData?.description?.includes('expired');
    const loggedIn = !!hasUser;
    const userId = accountData?.user?.uid ||
      accountData?.user?.user_id ||
      null;

    if (loggedIn) {
      return c.json({
        ok: true,
        cookieCount: cookies.length,
        userId,
        accountInfo: accountData,
        message: 'Session refreshed. You can now call /render.',
      });
    } else {
      const errDesc = accountData?.description || 'Unknown error';
      const missing = ['sessionid', 'passport', 'sid_tt', 'uid_tt', 'ssid_tt'].filter(name =>
        !cookies.some(c => c.name === name)
      );
      return c.json({
        ok: false,
        cookieCount: cookies.length,
        error: 'Cookies saved but session still invalid. ' + errDesc,
        missingCritical: missing,
        accountInfo: accountData,
        hint: 'Make sure you copied ALL cookies from a logged-in CapCut session. Missing: ' + missing.join(', '),
      }, 400);
    }
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'Login endpoint error');
    return c.json({ ok: false, error: e.message }, 500);
  } finally {
    if (browser) {
      await browser.close();
      await new Promise(r => setTimeout(r, 500)); // let chromium subprocesses exit
    }
  }
});

/**
 * POST /login/manual — start interactive browser for manual login (QR code or form)
 * Opens a non-headless browser (with Xvfb if no display) and waits for user to log in.
 * Returns when login is detected or timeout (5 min).
 */
app.post('/manual', async (c) => {
  // This endpoint launches a non-headless browser in background.
  // Since the server is typically headless, we need Xvfb.
  const { spawn } = await import('node:child_process');
  const scriptPath = path.resolve(config.projectRoot, 'scripts', 'manual-login.js');

  if (!fs.existsSync(scriptPath)) {
    return c.json({ ok: false, error: 'manual-login.js not found at ' + scriptPath }, 500);
  }

  // Spawn xvfb-run + node manual-login.js (background — fire and forget)
  const child = spawn('xvfb-run', [
    '--auto-servernum', "--server-args=-screen 0 1440x900x24",
    'node', scriptPath,
  ], {
    detached: true,
    stdio: 'ignore',
    cwd: config.projectRoot,
  });
  child.unref();

  return c.json({
    ok: true,
    message: 'Manual login browser started. Login at https://www.capcut.com/login in the browser window. Session will be saved to profile automatically.',
    pid: child.pid,
    note: 'After login, call GET /login/status to verify.',
  });
});

export default app;
