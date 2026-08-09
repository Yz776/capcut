// scripts/manual-login.js
// Run: node scripts/manual-login.js
// Tujuan: jalankan browser non-headless, login manual 1x (QR/email), simpan ke userDataDir
// sehingga next run API tinggal reuse session (skip email/password).
//
// Setelah login berhasil, tutup browser, lalu set:
//   CAPCUT_USER_DATA_DIR=./.capcut-profile
// di .env untuk reuse session.

import puppeteer from 'puppeteer';
import { config } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';
import path from 'node:path';

const userDataDir = path.resolve(config.projectRoot, './.capcut-profile');
logger.info({ userDataDir }, 'Manual login mode');

const browser = await puppeteer.launch({
  headless: false,
  userDataDir,
  defaultViewport: { width: 1440, height: 900 },
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

const pages = await browser.pages();
const page = pages[0] || await browser.newPage();
await page.goto(config.capcut.baseUrl + '/templates', { waitUntil: 'domcontentloaded' });

logger.info('Browser opened. Please login manually via QR / email.');
logger.info('After login, the script will detect the avatar and auto-close.');

// Poll untuk avatar setiap 5 detik
let tries = 0;
const interval = setInterval(async () => {
  tries++;
  try {
    const found = await page.$('[class*="avatar" i], [data-testid*="user" i]');
    if (found) {
      logger.info('Login detected! Saving state...');
      clearInterval(interval);
      await new Promise(r => setTimeout(r, 2000));
      await browser.close();
      logger.info(`Session saved to ${userDataDir}. Now set CAPCUT_USER_DATA_DIR=${userDataDir} in .env`);
      process.exit(0);
    }
  } catch (_) {}
  if (tries > 60) {
    logger.warn('Timeout (5 min). Closing. Try again.');
    clearInterval(interval);
    await browser.close();
    process.exit(1);
  }
}, 5000);
