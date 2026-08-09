// scripts/login-interactive.js
// Interactive login with CDP remote debugging enabled.
// Setelah browser jalan, kita bisa connect via CDP untuk inspect & interact form.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/utils/config.js';

const userDataDir = path.resolve(config.projectRoot, './.capcut-profile');
const screenshotPath = path.join(config.projectRoot, 'tmp', 'qr-latest.png');

console.log('userDataDir:', userDataDir);

const browser = await puppeteer.launch({
  headless: false,
  userDataDir,
  defaultViewport: { width: 1440, height: 900 },
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--remote-debugging-port=9222',
    '--remote-debugging-address=127.0.0.1',
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

browser.on('disconnected', () => {
  console.log('BROWSER_DISCONNECTED at', new Date().toISOString());
  process.exit(1);
});

const pages = await browser.pages();
const page = pages[0] || await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

console.log('Opening CapCut login...');
await page.goto('https://www.capcut.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));
console.log('Browser ready, CDP on :9222, URL:', page.url());

// Periodic screenshot + login detection
let tries = 0;
const interval = setInterval(async () => {
  tries++;
  try {
    const loggedIn = await page.$('[class*="avatar" i], [data-testid*="user" i]');
    if (loggedIn) {
      console.log('LOGIN_SUCCESS detected');
      clearInterval(interval);
      await new Promise(r => setTimeout(r, 2000));
      await browser.close();
      console.log('Session saved to', userDataDir);
      process.exit(0);
    }
    await page.screenshot({ path: screenshotPath, fullPage: false });
    if (tries % 4 === 0) {
      console.log(`[${tries}] Still waiting for login... URL: ${page.url()}`);
    }
  } catch (e) {}
}, 3000);

process.on('SIGINT', async () => {
  clearInterval(interval);
  console.log('SIGINT, closing...');
  try { await browser.close(); } catch (_) {}
  process.exit(0);
});
