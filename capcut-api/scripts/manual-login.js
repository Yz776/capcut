// scripts/manual-login.js
// Interactive login: gunakan xvfb (virtual display) untuk launch non-headless browser,
// buka CapCut login page, capture QR code screenshot secara berkala,
// deteksi login success, simpan session ke userDataDir.
//
// Cara pakai:
//   npm run login:manual
//   lalu buka /home/z/my-project/capcut-api/tmp/qr-latest.png di file manager
//   scan QR dengan aplikasi CapCut di HP
//   script akan auto-detect login & save session

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';

const userDataDir = path.resolve(config.projectRoot, './.capcut-profile');
const screenshotDir = path.join(config.projectRoot, 'tmp', 'login-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });
fs.rmSync(path.join(config.projectRoot, 'tmp', 'qr-latest.png'), { force: true });

logger.info({ userDataDir }, 'Manual login mode (xvfb + QR code screenshots)');

const browser = await puppeteer.launch({
  headless: false, // penting: butuh GUI rendering untuk CapCut SPA
  userDataDir,
  defaultViewport: { width: 1440, height: 900 },
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1440,900',
    '--start-maximized',
  ],
});

const pages = await browser.pages();
const page = pages[0] || await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

// Buka halaman login CapCut langsung
logger.info('Opening CapCut login page...');
await page.goto('https://www.capcut.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));

// Cari tombol "login with QR" jika ada, atau langsung ada QR code
logger.info('Looking for QR code on login page...');

let qrFound = false;
let lastScreenshotTime = 0;
let tries = 0;
const MAX_TRIES = 120; // 120 * 3s = 6 menit max

const interval = setInterval(async () => {
  tries++;
  try {
    // Cek apakah sudah login (avatar muncul)
    const loggedIn = await page.$('[class*="avatar" i], [data-testid*="user" i], [class*="user-info" i]');
    if (loggedIn) {
      logger.info('LOGIN SUCCESS detected!');
      clearInterval(interval);
      await new Promise(r => setTimeout(r, 2000));
      // Simpan cookies & state (otomatis karena pakai userDataDir)
      await browser.close();
      logger.info(`Session saved to ${userDataDir}`);
      logger.info('Set CAPCUT_USER_DATA_DIR=./.capcut-profile in .env to reuse.');
      process.exit(0);
    }

    // Cek apakah ada QR code di halaman
    const qrCanvas = await page.$('canvas, [class*="qr" i], img[alt*="qr" i], [class*="qrcode" i]');
    if (qrCanvas) {
      if (!qrFound) {
        logger.info('QR code detected! Saving screenshot...');
        qrFound = true;
      }
      // Save screenshot ke tmp/qr-latest.png (untuk viewer lihat real-time)
      const qrPath = path.join(screenshotDir, `qr-${Date.now()}.png`);
      await page.screenshot({ path: qrPath, fullPage: false });
      // Copy ke qr-latest.png
      fs.copyFileSync(qrPath, path.join(config.projectRoot, 'tmp', 'qr-latest.png'));
      lastScreenshotTime = Date.now();
      // Hapus screenshot lama (keep last 5)
      const files = fs.readdirSync(screenshotDir).filter(f => f.startsWith('qr-')).sort();
      while (files.length > 5) {
        fs.unlinkSync(path.join(screenshotDir, files.shift()));
      }
    } else {
      // Mungkin perlu klik tombol "login with QR" dulu
      if (tries === 1) {
        try {
          const qrBtn = await page.$('button:has-text("QR"), a:has-text("QR"), div:has-text("Scan QR"), [class*="qr-tab" i]');
          if (qrBtn) {
            logger.info('Clicking QR login tab...');
            await qrBtn.click();
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (_) {}
      }
    }

    // Screenshot juga untuk debugging tiap 15 detik
    if (tries % 5 === 0) {
      const debugPath = path.join(screenshotDir, `debug-${tries}.png`);
      await page.screenshot({ path: debugPath, fullPage: false });
    }

    if (tries % 4 === 0) {
      logger.info({ tries, qrFound, url: page.url() }, 'Waiting for login...');
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Interval check error');
  }

  if (tries > MAX_TRIES) {
    logger.warn(`Timeout after ${MAX_TRIES * 3} seconds. No login detected.`);
    clearInterval(interval);
    await browser.close();
    process.exit(1);
  }
}, 3000);

// Graceful shutdown
process.on('SIGINT', async () => {
  clearInterval(interval);
  logger.info('SIGINT received, closing browser...');
  await browser.close();
  process.exit(0);
});
