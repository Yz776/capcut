// scripts/capture-dashboard.js
// Run the login script in background, wait for QR, capture dashboard screenshot.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import puppeteer from 'puppeteer';

const PORT = 3704;
const projectRoot = '/home/z/my-project/capcut-api';
const outDir = '/home/z/my-project/download';

fs.mkdirSync(outDir, { recursive: true });

// Helper: download a URL to a file
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(dest);
    http.get(url, (res) => {
      if (res.statusCode !== 200) { f.close(); fs.rmSync(dest, { force: true }); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve()));
    }).on('error', reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

console.log('Spawning login script...');
const child = spawn('node', ['scripts/manual-login.js'], {
  cwd: projectRoot,
  env: { ...process.env, CAPCUT_LOGIN_PORT: String(PORT) },
  stdio: 'pipe',
});

child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));

// Wait for HTTP server to be ready (poll /health)
console.log(`\nWaiting for HTTP server on port ${PORT}...`);
let ready = false;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetchJson(`http://127.0.0.1:${PORT}/health`).catch(() => null);
    if (r?.ok) { ready = true; console.log('HTTP server ready!'); break; }
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 1000));
}

if (!ready) {
  console.error('HTTP server never came up.');
  child.kill('SIGKILL');
  process.exit(1);
}

// Poll /status until qrDetected === true, or timeout 25s
console.log('\nPolling /status until qrDetected=true (max 25s)...');
let finalStatus = null;
for (let i = 0; i < 25; i++) {
  try {
    const s = await fetchJson(`http://127.0.0.1:${PORT}/status`);
    finalStatus = s;
    console.log(`  [${i}s] phase=${s.currentPhase} qrDetected=${s.qrDetected} popupOpened=${s.popupOpened} pages=${s.pageCount} canvas=${s.canvasCount} err=${s.lastError || '-'}`);
    if (s.qrDetected) break;
  } catch (e) {
    console.log(`  [${i}s] status fetch failed: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// Give 2 extra seconds after QR detected for the QR png to be captured
await new Promise((r) => setTimeout(r, 2500));

// Download /qr and /
console.log('\nDownloading /qr and / ...');
await download(`http://127.0.0.1:${PORT}/qr?t=${Date.now()}`, `${outDir}/qr-scan-me.png`).catch((e) => console.error('qr download failed:', e.message));
const dashboardHtml = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
fs.writeFileSync(`${outDir}/dashboard-live.html`, dashboardHtml);
console.log(`Saved /qr -> ${outDir}/qr-scan-me.png`);
console.log(`Saved / -> ${outDir}/dashboard-live.html`);

// Now use a separate headless browser to render the dashboard HTML to a PNG
console.log('\nRendering dashboard to PNG with headless Chromium...');
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 1600 });
await page.setContent(dashboardHtml, { waitUntil: 'networkidle0', timeout: 15000 }).catch((e) => console.error('setContent failed:', e.message));
await new Promise((r) => setTimeout(r, 1000));
await page.screenshot({ path: `${outDir}/dashboard-screenshot.png`, fullPage: true }).catch((e) => console.error('screenshot failed:', e.message));
await browser.close();
console.log(`Saved dashboard screenshot -> ${outDir}/dashboard-screenshot.png`);

// Final status summary
if (finalStatus) {
  console.log('\n=== FINAL STATUS ===');
  console.log(JSON.stringify({
    phase: finalStatus.currentPhase,
    browserLaunched: finalStatus.browserLaunched,
    loginPageLoaded: finalStatus.loginPageLoaded,
    mobileButtonFound: finalStatus.mobileButtonFound,
    mobileButtonClicked: finalStatus.mobileButtonClicked,
    popupOpened: finalStatus.popupOpened,
    qrDetected: finalStatus.qrDetected,
    currentUrl: finalStatus.currentUrl,
    popupUrl: finalStatus.popupUrl,
    pageCount: finalStatus.pageCount,
    frameCount: finalStatus.frameCount,
    canvasCount: finalStatus.canvasCount,
    dialogCount: finalStatus.dialogCount,
    lastError: finalStatus.lastError,
    screenshots: (finalStatus.screenshots || []).map((s) => ({ name: s.name, kind: s.kind, sizeKB: Math.round(s.size / 1024) })),
    recentLogs: (finalStatus.recentLogs || []).slice(-10).map((l) => `[${l.level}] ${l.msg}`),
  }, null, 2));
}

// Cleanup
child.kill('SIGKILL');
await new Promise((r) => setTimeout(r, 1000));
process.exit(0);
