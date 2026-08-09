// scripts/manual-login.js
// CapCut manual login via COOKIE PASTE — no QR extraction, no VNC, no headless login.
//
// Flow:
// 1. HTTP dashboard on port 3002 (auto-fallback to 3003..3010 if busy)
// 2. User opens https://www.capcut.com/login in their OWN browser, logs in
//    (QR, email, Google, whatever — doesn't matter)
// 3. User exports cookies (via Cookie-Editor extension OR DevTools Application tab
//    OR `copy(document.cookie)` console snippet)
// 4. User pastes cookies into our dashboard textarea
// 5. We POST to /api/save-cookies → launch headless puppeteer with .capcut-profile,
//    setCookie(), navigate to https://www.capcut.com/my-cloud/material, check login state
// 6. If logged in → cookies persist in .capcut-profile automatically + saved to cookies.json
// 7. Dashboard shows success, ready to start API server
//
// Usage:
//   node scripts/manual-login.js
//   # SSH tunnel: ssh -L 3002:localhost:3002 root@<server>
//   # Open http://127.0.0.1:3002/ in local browser
//
// Environment:
//   CAPCUT_LOGIN_PORT=3002   (override default port)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Catch-all process error handlers — keep server alive even if validation crashes
process.on('uncaughtException', (e) => {
  console.error('[FATAL uncaughtException]', e.message);
  console.error(e.stack);
  state.phase = 'error';
  state.lastError = `Uncaught: ${e.message}`;
  state.message = `Uncaught exception: ${e.message}`;
});
process.on('unhandledRejection', (e) => {
  console.error('[FATAL unhandledRejection]', e?.message || e);
  console.error(e?.stack);
  state.phase = 'error';
  state.lastError = `Unhandled: ${e?.message || String(e)}`;
  state.message = `Unhandled rejection: ${e?.message || String(e)}`;
});
process.on('exit', (code) => {
  console.log(`[process] exit code=${code}`);
});
process.on('SIGTERM', () => console.log('[process] SIGTERM'));
process.on('SIGINT', () => { console.log('[process] SIGINT'); process.exit(0); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const userDataDir = path.resolve(projectRoot, '.capcut-profile');
const tmpDir = path.resolve(projectRoot, 'tmp');
const cookiesJsonPath = path.resolve(projectRoot, 'cookies.json');
const validationShotPath = path.join(tmpDir, 'login-validation.png');
fs.mkdirSync(tmpDir, { recursive: true });

// Clean up stale SingletonLock from previous crashed chrome instance
for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.rmSync(path.join(userDataDir, lockFile), { force: true }); } catch (_) {}
}

// ====== Config ======
const PREFERRED_PORT = parseInt(process.env.CAPCUT_LOGIN_PORT || '3002', 10);
const PORT_RANGE = 10;
const HOST = '0.0.0.0';

// ====== State ======
const state = {
  bootTime: Date.now(),
  phase: 'waiting',        // waiting | validating | success | error
  message: 'Paste your CapCut cookies below to begin.',
  cookieCount: 0,
  cookiesSavedAt: null,
  username: null,
  lastError: null,
  lastValidation: null,
  actualHttpPort: null,
  history: [],             // [{ts, phase, msg}]
};

function pushHistory(msg) {
  state.history.push({ ts: new Date().toISOString(), phase: state.phase, msg });
  if (state.history.length > 50) state.history.shift();
  console.log(`[${state.phase}] ${msg}`);
}

// ====== Port finder ======
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, HOST);
  });
}

async function findFreePort() {
  for (let i = 0; i < PORT_RANGE; i++) {
    const port = PREFERRED_PORT + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in range ${PREFERRED_PORT}-${PREFERRED_PORT + PORT_RANGE - 1}`);
}

// ====== Cookie parser ======
// Accepts:
//  (a) JSON array from Cookie-Editor extension: [{name, value, domain, ...}]
//  (b) JSON object: {cookies: [...]} or {name: value, ...}
//  (c) Cookie header string: name1=value1; name2=value2
//  (d) Netscape cookies.txt format (one cookie per line, tab-separated)
function parseCookies(rawInput) {
  const input = rawInput.trim();
  if (!input) throw new Error('Empty input');

  // Try JSON
  if (input.startsWith('[') || input.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(input);
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }

    let arr = null;
    if (Array.isArray(data)) {
      arr = data;
    } else if (Array.isArray(data.cookies)) {
      arr = data.cookies;
    } else if (typeof data === 'object') {
      // Could be a {name: value} map
      const possibleCookies = Object.entries(data).filter(([k, v]) =>
        typeof v === 'string' || typeof v === 'number'
      );
      if (possibleCookies.length > 0) {
        arr = possibleCookies.map(([name, value]) => ({
          name, value: String(value), domain: '.capcut.com', path: '/',
        }));
      }
    }
    if (!arr || arr.length === 0) {
      throw new Error('JSON did not contain any cookies');
    }

    return arr.map(c => normalizeCookie(c)).filter(Boolean);
  }

  // Try Netscape format (starts with comment or has tabs)
  if (input.startsWith('#') || input.includes('\t')) {
    const lines = input.split(/\r?\n/);
    const cookies = [];
    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const [domain, flag, path, secure, expiration, name, value] = parts;
      cookies.push({
        name,
        value,
        domain: domain.startsWith('.') ? domain : `.${domain}`,
        path: path || '/',
        secure: secure === 'TRUE',
        expires: parseInt(expiration, 10) || undefined,
        httpOnly: false,
      });
    }
    if (cookies.length > 0) return cookies.map(normalizeCookie).filter(Boolean);
  }

  // Try cookie header: name1=value1; name2=value2
  if (input.includes('=')) {
    const cookies = input.split(';').map(c => c.trim()).filter(Boolean).map(c => {
      const idx = c.indexOf('=');
      if (idx === -1) return null;
      return {
        name: c.slice(0, idx).trim(),
        value: c.slice(idx + 1).trim(),
        domain: '.capcut.com',
        path: '/',
      };
    }).filter(Boolean);
    if (cookies.length > 0) return cookies.map(normalizeCookie).filter(Boolean);
  }

  throw new Error('Could not parse input as JSON, Netscape, or cookie header format');
}

function normalizeCookie(c) {
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name || '').trim();
  const value = String(c.value ?? '').trim();
  if (!name) return null;

  let domain = String(c.domain || '.capcut.com').trim();
  // Cookie-Editor sometimes uses hostOnly + domain without leading dot
  if (!domain.startsWith('.') && !domain.startsWith('http')) {
    domain = `.${domain}`;
  }
  // Strip protocol if present
  domain = domain.replace(/^https?:\/\//, '');

  let sameSite = (c.sameSite || 'lax').toString().toLowerCase();
  if (!['strict', 'lax', 'none'].includes(sameSite)) sameSite = 'lax';

  const cookie = {
    name,
    value,
    domain,
    path: c.path || '/',
    secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false,
    sameSite,
  };

  // Puppeteer expects sameSite: 'Lax' | 'Strict' | 'None' (capitalized)
  cookie.sameSite = sameSite.charAt(0).toUpperCase() + sameSite.slice(1);

  // Expiration
  if (c.expirationDate && Number.isFinite(c.expirationDate)) {
    cookie.expires = c.expirationDate;
  } else if (c.expires && Number.isFinite(c.expires)) {
    cookie.expires = c.expires;
  }

  return cookie;
}

// ====== Validate + save cookies (via subprocess) ======
// We spawn scripts/validate-cookies.js as a child process so that:
//  - The HTTP server stays alive even if puppeteer/chrome crashes hard
//  - Any uncaught exception in the validator doesn't take down the dashboard
//  - The chrome process tree is fully reaped when the subprocess exits
async function validateAndSaveCookies(rawCookieInput) {
  const validatorScript = path.resolve(__dirname, 'validate-cookies.js');
  if (!fs.existsSync(validatorScript)) {
    throw new Error(`Validator script not found: ${validatorScript}`);
  }

  pushHistory(`Spawning validator subprocess: ${validatorScript}`);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [validatorScript], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // Stream stdout lines as live progress
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          // Likely the final JSON result — don't log it as progress
          continue;
        }
        if (trimmed) pushHistory(`[validator] ${trimmed}`);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      // Stream stderr lines as live progress
      for (const line of chunk.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) pushHistory(`[validator] ${trimmed}`);
      }
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      pushHistory(`Failed to spawn validator: ${err.message}`);
      resolve({ ok: false, error: `Spawn failed: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      pushHistory(`Validator exited code=${code} signal=${signal || '(none)'}`);

      // Parse the last JSON object from stdout
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      let result = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          result = JSON.parse(lines[i]);
          break;
        } catch (_) {}
      }

      if (!result) {
        resolve({
          ok: false,
          error: `Validator produced no JSON. Exit code ${code}, signal ${signal}. stderr: ${stderr.slice(-500)}`,
        });
        return;
      }

      resolve(result);
    });

    // Write the raw cookie input to the child's stdin
    try {
      child.stdin.write(rawCookieInput);
      child.stdin.end();
    } catch (e) {
      pushHistory(`Failed to write to validator stdin: ${e.message}`);
      try { child.kill('SIGTERM'); } catch (_) {}
    }

    // Safety timeout — 90s
    setTimeout(() => {
      if (!resolved) {
        pushHistory('Validator timed out after 90s, killing');
        try { child.kill('SIGKILL'); } catch (_) {}
        resolved = true;
        resolve({ ok: false, error: 'Validator timed out after 90 seconds' });
      }
    }, 90000);
  });
}

// ====== HTTP server ======
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS (in case user runs snippet from capcut.com tab)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Dashboard
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHTML());
    return;
  }

  // Status
  if (url.pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...state,
      uptimeSec: Math.floor((Date.now() - state.bootTime) / 1000),
      cookiesJsonExists: fs.existsSync(cookiesJsonPath),
      profileExists: fs.existsSync(userDataDir),
      validationScreenshotExists: fs.existsSync(validationShotPath),
    }));
    return;
  }

  // Validation screenshot
  if (url.pathname === '/validation-screenshot' && req.method === 'GET') {
    if (!fs.existsSync(validationShotPath)) {
      res.writeHead(404);
      res.end('No screenshot yet');
      return;
    }
    const buf = fs.readFileSync(validationShotPath);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(buf);
    return;
  }

  // Snippet for console (returns JS that extracts cookies via document.cookie)
  if (url.pathname === '/api/snippet' && req.method === 'GET') {
    const port = state.actualHttpPort;
    const snippet = `(function(){
      var cookies = document.cookie.split('; ').map(function(pair){
        var i = pair.indexOf('=');
        return { name: pair.slice(0,i), value: pair.slice(i+1), domain: '.capcut.com', path: '/', secure: true, httpOnly: false, sameSite: 'lax' };
      });
      fetch('http://127.0.0.1:${port}/api/save-cookies', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(cookies)
      }).then(function(r){return r.text();}).then(function(t){
        alert('Sent '+cookies.length+' cookies to dashboard. Check the dashboard tab.');
      }).catch(function(e){ alert('Failed: '+e.message); });
    })();`;
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(snippet);
    return;
  }

  // Save cookies endpoint
  if (url.pathname === '/api/save-cookies' && req.method === 'POST') {
    // Read body
    let body = '';
    let bodySize = 0;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > 1024 * 1024) { // 1MB limit
        req.destroy();
        res.writeHead(413);
        res.end('Body too large');
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      try {
        if (state.phase === 'validating') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Validation already in progress' }));
          return;
        }

        // Pre-validate the input format (without actually parsing it here,
        // so we can give a clean error before launching the subprocess)
        let previewCount;
        try {
          const parsed = parseCookies(body);
          previewCount = parsed.length;
        } catch (e) {
          state.phase = 'error';
          state.lastError = e.message;
          state.message = `Parse error: ${e.message}`;
          pushHistory(`Cookie parse failed: ${e.message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Parse error: ${e.message}` }));
          return;
        }

        if (previewCount === 0) {
          state.phase = 'error';
          state.lastError = 'No cookies found in input';
          state.message = 'No cookies found in input';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No cookies found' }));
          return;
        }

        state.phase = 'validating';
        state.message = `Validating ${previewCount} cookies...`;
        state.cookieCount = previewCount;
        state.lastError = null;
        pushHistory(`Received ${previewCount} cookies, starting validation`);

        // Send immediate ack
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ack: true, message: 'Validation started', cookieCount: previewCount }));

        // Run validation in background (subprocess)
        try {
          const result = await validateAndSaveCookies(body);
          state.lastValidation = result;

          if (result.ok) {
            state.phase = 'success';
            state.message = `Login saved! ${result.reason || 'Cookies valid'}`;
            state.cookiesSavedAt = new Date().toISOString();
            state.username = result.username;
            pushHistory(`VALIDATION SUCCESS: ${result.reason}`);
          } else {
            state.phase = 'error';
            state.lastError = result.error;
            state.message = `Validation failed: ${result.error}`;
            pushHistory(`VALIDATION FAILED: ${result.error}`);
          }
        } catch (e) {
          state.phase = 'error';
          state.lastError = e.message;
          state.message = `Validation error: ${e.message}`;
          pushHistory(`VALIDATION ERROR: ${e.message}`);
          console.error(e.stack);
        }
      } catch (e) {
        state.phase = 'error';
        state.lastError = e.message;
        state.message = `Server error: ${e.message}`;
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        } catch (_) {}
      }
    });
    return;
  }

  // Reset state
  if (url.pathname === '/api/reset' && req.method === 'POST') {
    state.phase = 'waiting';
    state.message = 'Paste your CapCut cookies below to begin.';
    state.lastError = null;
    state.lastValidation = null;
    state.cookiesSavedAt = null;
    state.username = null;
    state.cookieCount = 0;
    pushHistory('State reset by user');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ====== Dashboard HTML ======
function dashboardHTML() {
  const port = state.actualHttpPort;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CapCut Manual Login</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    margin: 0; padding: 0;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
    color: #e8e8e8; min-height: 100vh;
  }
  .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  h1 {
    font-size: 32px; font-weight: 700; margin: 0 0 8px;
    background: linear-gradient(90deg, #00d2ff, #3a7bd5);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .subtitle { color: #8a8a9a; font-size: 14px; margin-bottom: 32px; }
  .status-bar {
    display: flex; align-items: center; gap: 16px;
    padding: 16px 20px; border-radius: 12px; margin-bottom: 24px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
    transition: all 0.3s;
  }
  .status-bar.validating { background: rgba(255, 193, 7, 0.1); border-color: rgba(255, 193, 7, 0.4); }
  .status-bar.success    { background: rgba(40, 167, 69, 0.15); border-color: rgba(40, 167, 69, 0.5); }
  .status-bar.error      { background: rgba(220, 53, 69, 0.15); border-color: rgba(220, 53, 69, 0.5); }
  .status-dot {
    width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
    background: #6c757d;
  }
  .status-bar.validating .status-dot { background: #ffc107; animation: pulse 1.2s infinite; }
  .status-bar.success    .status-dot { background: #28a745; }
  .status-bar.error      .status-dot { background: #dc3545; }
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
  .status-text { flex: 1; font-size: 15px; }
  .status-phase { font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: 0.5px; opacity: 0.7; }
  .status-message { font-size: 16px; margin-top: 2px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px; padding: 24px;
  }
  .card h2 { margin: 0 0 16px; font-size: 18px; font-weight: 600; color: #fff; }
  .steps { list-style: none; padding: 0; margin: 0; counter-reset: step; }
  .steps li {
    counter-increment: step; padding: 12px 0 12px 48px; position: relative;
    border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 14px; line-height: 1.6;
  }
  .steps li:last-child { border-bottom: none; }
  .steps li::before {
    content: counter(step); position: absolute; left: 0; top: 12px;
    width: 28px; height: 28px; border-radius: 50%;
    background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 13px;
  }
  .steps code {
    background: rgba(0,0,0,0.4); padding: 2px 6px; border-radius: 4px;
    font-family: 'SFMono-Regular', Menlo, monospace; font-size: 12px; color: #00d2ff;
  }
  .steps a { color: #00d2ff; text-decoration: none; }
  .steps a:hover { text-decoration: underline; }
  .btn {
    display: inline-block; padding: 8px 14px; border-radius: 6px; font-size: 13px;
    font-weight: 600; cursor: pointer; border: none; text-decoration: none;
    transition: all 0.2s; font-family: inherit;
  }
  .btn-primary {
    background: linear-gradient(135deg, #00d2ff, #3a7bd5); color: #fff;
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,210,255,0.3); }
  .btn-secondary {
    background: rgba(255,255,255,0.1); color: #e8e8e8; border: 1px solid rgba(255,255,255,0.2);
  }
  .btn-secondary:hover { background: rgba(255,255,255,0.15); }
  .btn-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  textarea {
    width: 100%; min-height: 180px; padding: 12px; border-radius: 8px;
    background: rgba(0,0,0,0.4); color: #e8e8e8; border: 1px solid rgba(255,255,255,0.15);
    font-family: 'SFMono-Regular', Menlo, monospace; font-size: 12px; resize: vertical;
  }
  textarea:focus { outline: none; border-color: #00d2ff; }
  textarea:disabled { opacity: 0.5; cursor: not-allowed; }
  .actions { display: flex; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
  .history {
    max-height: 240px; overflow-y: auto; padding: 12px; background: rgba(0,0,0,0.3);
    border-radius: 8px; font-family: 'SFMono-Regular', Menlo, monospace; font-size: 11px;
    line-height: 1.5;
  }
  .history-line { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .history-line:last-child { border-bottom: none; }
  .history-ts { color: #6c757d; }
  .history-phase { color: #00d2ff; font-weight: 600; }
  .history-phase.success { color: #28a745; }
  .history-phase.error { color: #dc3545; }
  .history-phase.validating { color: #ffc107; }
  .screenshot-card { padding: 16px; }
  .screenshot-card img { width: 100%; border-radius: 8px; margin-top: 8px; }
  .metadata { font-size: 12px; color: #8a8a9a; margin-top: 8px; }
  .metadata strong { color: #e8e8e8; }
  .hint {
    background: rgba(0, 210, 255, 0.08); border-left: 3px solid #00d2ff;
    padding: 12px 14px; margin-top: 12px; border-radius: 4px; font-size: 12px;
    line-height: 1.5;
  }
  .hint strong { color: #00d2ff; }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px;
    font-weight: 600; margin-left: 6px;
  }
  .badge-ok { background: rgba(40,167,69,0.2); color: #28a745; }
  .badge-no { background: rgba(220,53,69,0.2); color: #dc3545; }
  .badge-neutral { background: rgba(108,117,125,0.2); color: #8a8a9a; }
  .next-steps {
    margin-top: 16px; padding: 16px; background: rgba(40,167,69,0.1);
    border-radius: 8px; border: 1px solid rgba(40,167,69,0.3);
  }
  .next-steps h3 { margin: 0 0 8px; font-size: 14px; color: #28a745; }
  .next-steps code {
    background: rgba(0,0,0,0.4); padding: 6px 10px; border-radius: 4px;
    font-family: monospace; font-size: 12px; display: block; margin-top: 6px;
    color: #00d2ff;
  }
</style>
</head>
<body>
<div class="container">
  <h1>CapCut Manual Login</h1>
  <div class="subtitle">Login in your own browser, paste cookies here. No QR extraction, no headless login.</div>

  <div id="status-bar" class="status-bar">
    <div class="status-dot"></div>
    <div class="status-text">
      <div id="status-phase" class="status-phase">Waiting</div>
      <div id="status-message" class="status-message">Loading...</div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>How to login</h2>
      <ol class="steps">
        <li>
          Open <a href="https://www.capcut.com/login" target="_blank">https://www.capcut.com/login</a>
          in your browser.
        </li>
        <li>
          Login using any method (CapCut Mobile QR, email, Google, etc.).
        </li>
        <li>
          After login succeeds, export your cookies. Easiest: install the
          <a href="https://cookie-editor.com" target="_blank">Cookie-Editor</a> browser extension,
          click its icon, then click <strong>Export</strong> → <strong>Export as JSON</strong>.
        </li>
        <li>
          Paste the exported JSON into the textarea on the right and click
          <strong>Save & Validate</strong>.
        </li>
        <li>
          Wait ~10 seconds. The program will launch a headless browser, set your cookies,
          navigate to a login-gated page, and verify you're logged in.
        </li>
      </ol>

      <div class="hint">
        <strong>Alternative methods (if you can't install Cookie-Editor):</strong>
        <ul style="margin:6px 0 0 0; padding-left: 18px;">
          <li><strong>DevTools:</strong> F12 → Application → Cookies → https://www.capcut.com → copy each cookie row</li>
          <li><strong>Console snippet:</strong> After logging in, run this in the CapCut tab's console (F12 → Console):
            <code style="display:block;margin-top:4px;background:rgba(0,0,0,0.4);padding:6px 8px;border-radius:4px;font-size:11px;">javascript:(function(){var c=document.cookie.split('; ').map(function(p){var i=p.indexOf('=');return{name:p.slice(0,i),value:p.slice(i+1),domain:'.capcut.com',path:'/',secure:true,httpOnly:false,sameSite:'lax'};});fetch('http://127.0.0.1:${port}/api/save-cookies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)}).then(function(r){return r.text();}).then(function(t){alert('Sent '+c.length+' cookies (note: HttpOnly cookies like sessionid are NOT included). Use Cookie-Editor for full cookies.');}).catch(function(e){alert('Failed: '+e.message);});})();</code>
            ⚠️ This bookmarklet does NOT capture HttpOnly cookies (sessionid). Use Cookie-Editor for a full export.
          </li>
        </ul>
      </div>
    </div>

    <div class="card">
      <h2>Paste cookies</h2>
      <textarea id="cookies-input" placeholder='Paste cookies here. Accepted formats:
  • Cookie-Editor JSON: [{"name":"...","value":"...","domain":"..."}, ...]
  • Cookie header: name1=value1; name2=value2
  • Netscape cookies.txt format'></textarea>
      <div class="actions">
        <button class="btn btn-primary" id="save-btn" onclick="saveCookies()">Save &amp; Validate</button>
        <button class="btn btn-secondary" id="clear-btn" onclick="clearInput()">Clear</button>
        <button class="btn btn-secondary" id="reset-btn" onclick="resetState()">Reset State</button>
      </div>

      <div id="result-area" style="margin-top: 16px;"></div>

      <div id="next-steps" style="display:none;" class="next-steps">
        <h3>✓ Login saved! Next steps</h3>
        <div>You can now start the CapCut render API:</div>
        <code>cd capcut-api &amp;&amp; npm start</code>
        <div style="margin-top:8px;">Then check session validity:</div>
        <code>node scripts/verify-session.js</code>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Validation log</h2>
      <div id="history" class="history">
        <div class="history-line"><span class="history-ts">--:--:--</span> <span class="history-phase">waiting</span> Loading...</div>
      </div>
    </div>

    <div class="card screenshot-card">
      <h2>Validation screenshot</h2>
      <div id="screenshot-meta" class="metadata">No screenshot yet. After validation, this shows the page the headless browser loaded.</div>
      <img id="validation-screenshot" src="" alt="" style="display:none;" />
    </div>
  </div>
</div>

<script>
  const port = ${port};
  let pollTimer = null;

  async function fetchStatus() {
    try {
      const r = await fetch('/api/status');
      const s = await r.json();
      updateUI(s);
    } catch (e) {
      console.error('Status poll error:', e);
    }
  }

  function updateUI(s) {
    const bar = document.getElementById('status-bar');
    const phase = document.getElementById('status-phase');
    const msg = document.getElementById('status-message');

    bar.className = 'status-bar ' + s.phase;
    phase.textContent = s.phase.toUpperCase();
    phase.className = 'status-phase ' + s.phase;
    msg.textContent = s.message;

    // History
    const histEl = document.getElementById('history');
    if (s.history && s.history.length > 0) {
      histEl.innerHTML = s.history.slice().reverse().map(h => {
        const t = h.ts.split('T')[1].split('.')[0];
        return '<div class="history-line"><span class="history-ts">' + t + '</span> <span class="history-phase ' + h.phase + '">[' + h.phase + ']</span> ' + escapeHtml(h.msg) + '</div>';
      }).join('');
    }

    // Screenshot
    const ssImg = document.getElementById('validation-screenshot');
    const ssMeta = document.getElementById('screenshot-meta');
    if (s.validationScreenshotExists) {
      ssImg.style.display = 'block';
      ssImg.src = '/validation-screenshot?t=' + Date.now();
      if (s.lastValidation) {
        const v = s.lastValidation;
        ssMeta.innerHTML = 'URL: <strong>' + escapeHtml(v.finalUrl || '') + '</strong><br>' +
          'Title: <strong>' + escapeHtml(v.title || '') + '</strong><br>' +
          'Cookies set: <strong>' + (v.cookieCount || 0) + '</strong>, ' +
          'Session cookies: <strong>' + (v.sessionCookieCount || 0) + '</strong><br>' +
          'passport: ' + badge(v.hasPassport) + ' ' +
          'sessionid: ' + badge(v.hasSessionId) + '<br>' +
          'avatar: ' + badge(v.probe?.hasAvatar) + ' ' +
          'loginText: ' + badge(v.probe?.hasLoginText) + ' ' +
          'accountText: ' + badge(v.probe?.hasAccountText);
      } else {
        ssMeta.textContent = 'Screenshot available';
      }
    } else {
      ssImg.style.display = 'none';
      ssMeta.textContent = 'No screenshot yet. After validation, this shows the page the headless browser loaded.';
    }

    // Result + next steps
    const resultArea = document.getElementById('result-area');
    const nextSteps = document.getElementById('next-steps');
    if (s.phase === 'success') {
      resultArea.innerHTML = '<div style="padding:12px;background:rgba(40,167,69,0.15);border:1px solid rgba(40,167,69,0.4);border-radius:8px;color:#28a745;">' +
        '<strong>✓ Login successful!</strong> ' + escapeHtml(s.message) + '</div>';
      nextSteps.style.display = 'block';
    } else if (s.phase === 'error') {
      resultArea.innerHTML = '<div style="padding:12px;background:rgba(220,53,69,0.15);border:1px solid rgba(220,53,69,0.4);border-radius:8px;color:#dc3545;">' +
        '<strong>✗ Validation failed</strong><br>' + escapeHtml(s.lastError || s.message) + '</div>';
      nextSteps.style.display = 'none';
    } else if (s.phase === 'validating') {
      resultArea.innerHTML = '<div style="padding:12px;background:rgba(255,193,7,0.15);border:1px solid rgba(255,193,7,0.4);border-radius:8px;color:#ffc107;">' +
        '⏳ Validating cookies... (launching headless browser, this takes ~10s)</div>';
      nextSteps.style.display = 'none';
    } else {
      resultArea.innerHTML = '';
      nextSteps.style.display = 'none';
    }

    // Disable input while validating
    const input = document.getElementById('cookies-input');
    const saveBtn = document.getElementById('save-btn');
    input.disabled = (s.phase === 'validating');
    saveBtn.disabled = (s.phase === 'validating');
    saveBtn.textContent = (s.phase === 'validating') ? 'Validating...' : 'Save & Validate';
  }

  function badge(v) {
    if (v === true || v === 'true') return '<span class="badge badge-ok">YES</span>';
    if (v === false || v === 'false') return '<span class="badge badge-no">NO</span>';
    return '<span class="badge badge-neutral">?</span>';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function saveCookies() {
    const input = document.getElementById('cookies-input');
    const text = input.value.trim();
    if (!text) {
      alert('Paste cookies first');
      return;
    }
    try {
      const r = await fetch('/api/save-cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const data = await r.json();
      if (!data.ok && !data.ack) {
        alert('Error: ' + (data.error || 'Unknown'));
      }
      // UI will update via poll
    } catch (e) {
      alert('Request failed: ' + e.message);
    }
  }

  function clearInput() {
    document.getElementById('cookies-input').value = '';
  }

  async function resetState() {
    if (!confirm('Reset state?')) return;
    await fetch('/api/reset', { method: 'POST' });
    fetchStatus();
  }

  // Start polling
  fetchStatus();
  pollTimer = setInterval(fetchStatus, 2000);
</script>
</body>
</html>`;
}

// ====== Boot ======
(async () => {
  const port = await findFreePort();
  state.actualHttpPort = port;

  await new Promise((resolve) => {
    server.listen(port, HOST, () => resolve());
  });

  pushHistory(`HTTP dashboard listening on http://${HOST}:${port}/`);
  pushHistory(`Profile dir: ${userDataDir}`);
  pushHistory(`Existing profile: ${fs.existsSync(userDataDir) ? 'YES' : 'NO'}`);
  pushHistory(`Existing cookies.json: ${fs.existsSync(cookiesJsonPath) ? 'YES' : 'NO'}`);

  console.log('');
  console.log('============================================================');
  console.log('  CapCut Manual Login (cookie paste mode)');
  console.log('============================================================');
  console.log(`  Dashboard:  http://127.0.0.1:${port}/`);
  console.log(`  Profile:    ${userDataDir}`);
  console.log(`  cookies.json: ${cookiesJsonPath}`);
  console.log('');
  console.log('  Steps:');
  console.log('    1. Open the dashboard URL in your browser (via SSH tunnel if remote)');
  console.log('    2. Login at https://www.capcut.com/login in another tab');
  console.log('    3. Use Cookie-Editor extension to export cookies as JSON');
  console.log('    4. Paste JSON into the dashboard textarea');
  console.log('    5. Click "Save & Validate"');
  console.log('');
  console.log('  SSH tunnel example:');
  console.log(`    ssh -L ${port}:localhost:${port} root@<your-server>`);
  console.log('============================================================');
  console.log('');
})();
