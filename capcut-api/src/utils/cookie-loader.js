// src/utils/cookie-loader.js
//
// Shared cookie loader. Reads cookies from a JSON file (no puppeteer spawn).
//
// Cookie storage:
//   - .capcut-profile/cookies.json — plain JSON array of {name, value, domain, ...}
//   - Written by /login endpoint when user pastes cookies
//   - Read by all services (direct-api, login status check, etc.)
//
// Fallback: if cookies.json doesn't exist, try loading via puppeteer (slow, memory-heavy)
// and save the result to cookies.json for next time.

import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
import { logger } from './logger.js';

const COOKIE_FILE = path.join(
  config.browser.userDataDir || path.resolve(config.projectRoot, '.capcut-profile'),
  'cookies.json'
);

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _cache = null; // { header, csrfToken, all, ts }

const userDataDir = config.browser.userDataDir ||
  path.resolve(config.projectRoot, '.capcut-profile');

/**
 * Load cookies from cookies.json (fast, no puppeteer).
 * If cookies.json doesn't exist, fall back to puppeteer (one-time) and save the result.
 * @param {boolean} forceRefresh - bypass cache
 * @returns {Promise<{header: string, csrfToken: string|null, all: Object[], ts: number}>}
 */

function expandSessionAliases(cookies) {
  const names = new Set(cookies.map(c => c.name));
  const out = [...cookies];
  const alias = (from, to) => {
    if (names.has(from) && !names.has(to)) {
      const src = cookies.find(c => c.name === from);
      if (src) out.push({ ...src, name: to });
    }
  };
  alias('sessionid_ss', 'sessionid');
  alias('uid_tt_ss', 'uid_tt');
  alias('ssid_tt', 'sid_tt');
  return out;
}

export async function loadCookies(forceRefresh = false) {
  const now = Date.now();
  if (_cache && !forceRefresh && (now - _cache.ts) < CACHE_TTL_MS) {
    return _cache;
  }

  // Try cookies.json first (fast path, no puppeteer)
  let cookies = null;
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const raw = fs.readFileSync(COOKIE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        cookies = parsed;
        logger.debug({ count: cookies.length, src: 'json' }, 'Loaded cookies from cookies.json');
      }
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to read cookies.json, falling back to puppeteer');
  }

  // Fallback: load via puppeteer (slow, memory-heavy)
  if (!cookies || cookies.length === 0) {
    cookies = await loadCookiesViaPuppeteer();
    // Save to cookies.json for next time
    try {
      fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
      logger.info({ count: cookies.length, path: COOKIE_FILE }, 'Saved cookies to cookies.json for fast loading');
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed to save cookies.json');
    }
  }

  if (!cookies || cookies.length === 0) {
    throw new Error('No cookies found. Open /login in browser and paste cookies first.');
  }

  cookies = expandSessionAliases(cookies);

  const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const csrfCookie = cookies.find(c => c.name === 'passport_csrf_token') ||
                     cookies.find(c => c.name === 'passport_csrf_token_default');

  _cache = {
    header,
    csrfToken: csrfCookie?.value || null,
    all: cookies,
    ts: now,
  };
  logger.info({ cookieCount: cookies.length, hasCsrf: !!csrfCookie?.value }, 'Loaded cookies');
  return _cache;
}

/**
 * Save cookies to cookies.json (used by /login endpoint).
 * Also invalidates cache so next loadCookies() picks up the new cookies.
 * @param {Object[]} cookies — array of {name, value, domain, path, ...}
 */
export function saveCookiesToJson(cookies) {
  try {
    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    invalidateCache();
    logger.info({ count: cookies.length, path: COOKIE_FILE }, 'Saved cookies to cookies.json');
    return true;
  } catch (e) {
    logger.error({ err: e.message }, 'Failed to save cookies.json');
    return false;
  }
}

/**
 * Load cookies via puppeteer (slow, memory-heavy, used as fallback only).
 */
async function loadCookiesViaPuppeteer() {
  // Cleanup stale Chromium locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(userDataDir, lock), { force: true }); } catch {}
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',  // reduce memory
      '--no-zygote',       // reduce memory
    ],
  });

  try {
    const page = await browser.newPage();
    await page.goto('https://www.capcut.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const cookies = await browser.cookies('https://www.capcut.com', 'https://capcut.com');
    return cookies;
  } finally {
    await browser.close();
    // Give chromium subprocesses a moment to fully exit
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * Invalidate the cookie cache. Next loadCookies() call will reload from cookies.json.
 */
export function invalidateCache() {
  _cache = null;
  logger.info('Cookie cache invalidated');
}

/**
 * Get the current cache info (without reloading).
 */
export function getCacheInfo() {
  if (!_cache) return { cached: false };
  return {
    cached: true,
    cookieCount: _cache.all.length,
    ageMs: Date.now() - _cache.ts,
    expiresMs: CACHE_TTL_MS - (Date.now() - _cache.ts),
  };
}

export default { loadCookies, saveCookiesToJson, invalidateCache, getCacheInfo };
