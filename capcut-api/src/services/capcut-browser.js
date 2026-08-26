// src/services/capcut-browser.js
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../utils/config.js';
import { sleep } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

/**
 * CapCut browser automation class (PUPPETEER-BASED).
 *
 * NOTE: Untuk list/search/get template info, PAKAI capcut-api.js (axios langsung).
 * Class ini dipakai HANYA untuk render (yang butuh editor SPA + login).
 *
 * Lifecycle:
 *   const b = new CapCutBrowser();
 *   await b.launch();
 *   await b.login();
 *   const result = await b.renderTemplate({id:'123', editorUrl:'...'}, imagePaths);
 *   await b.close();
 *
 * Alur render (VERIFIED 2025-08):
 *   1. Login CapCut (email/password atau reuse userDataDir)
 *   2. Buka https://www.capcut.com/editor-template?create_id={id}
 *      - Kalau belum login → redirect ke /login?redirect_url=...
 *   3. Editor SPA load (CapCut web editor — berat, butuh WebGL)
 *   4. Upload images via <input type="file">
 *   5. Click Export → wait render → download MP4
 */

const SELECTORS = {
  // login
  loginButton: 'header a[href*="login"]',
  emailInput: 'input[type="email"], input[name="email"], input[placeholder*="mail" i]',
  passwordInput: 'input[type="password"], input[name="password"]',
  submitLogin: 'button[type="submit"]',
  loginSuccessIndicator: '[class*="avatar" i], [data-testid*="user" i]',

  // Editor (updated 2026-08 berdasarkan inspect-editor.js)
  editorReady: 'canvas, [class*="track" i], [class*="editor-canvas" i]',
  // Export button di CapCut pakai class khusus "export-video-btn"
  // Tunggu sampai TIDAK ada class "lv-btn-disabled"
  renderButton: 'button.export-video-btn',
  renderButtonActive: 'button.export-video-btn:not(.lv-btn-disabled)',
  // NOTE: jangan pakai :has-text() — itu syntax Playwright, BUKAN Puppeteer.
  // Pakai page.evaluate + textContent filter untuk cari tombol by-text.
  uploadButton: '[class*="upload" i] button, button[class*="upload" i]',
  fileInput: 'input[type="file"]',
  renderProgress: '[class*="progress" i], [role="progressbar"]',
  renderDone: 'a[download], a[href*=".mp4"], [class*="download" i] a[href]',

  // Modals (CapCut suka nampilin modal promo yang nge-block UI)
  modalClose: '.lv-modal-close-icon, [class*="modal-close" i], [aria-label*="close" i]',
  modalMask: '.lv-modal-mask',
  // Modal sign-in yang muncul kalau session editor tidak valid
  signInModal: '.lv_sign_in_panel_wide_base_page, [class*="sign_in_panel" i]',
};

/**
 * Hapus SingletonLock/SingletonCookie/SingletonSocket dari userDataDir.
 *
 * Chromium bikin file-file ini saat launch untuk mencegah multi-instance.
 * Kalau process Chromium sebelumnya crash tanpa cleanup, file-file ini tetap ada
 * dan bikin launch berikutnya gagal dengan error:
 *   "Failed to create SingletonLock: File exists"
 *
 * Aman dihapus karena kita selalu launch 1 instance per process.
 */
function cleanupChromiumLocks(userDataDir) {
  if (!userDataDir) return;
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(userDataDir, lockFile);
    try {
      fs.rmSync(lockPath, { force: true });
    } catch (_) {
      // ignore
    }
  }
}

export class CapCutBrowser {
  constructor() {
    this.browser = null;
    this.page = null;
    this._loggedIn = false;
    this._langPath = 'zh-tw'; // CapCut default region untuk IP ini
  }

  async launch() {
    // Cleanup stale SingletonLock dari previous crashed Chromium instance.
    // Tanpa ini, launch bisa gagal dengan "Failed to create SingletonLock: File exists".
    if (config.browser.userDataDir) {
      cleanupChromiumLocks(config.browser.userDataDir);
    }

    const launchOpts = {
      headless: config.browser.headless,
      slowMo: config.browser.slowMo,
      defaultViewport: {
        width: config.browser.viewportWidth,
        height: config.browser.viewportHeight,
      },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1440,900',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--enable-features=Vulkan',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        // Remote debugging — allows live inspection via puppeteer.connect() if a job hangs
        '--remote-debugging-port=9222',
      ],
    };

    if (config.browser.userDataDir) {
      this.browser = await puppeteer.launch({ ...launchOpts, userDataDir: config.browser.userDataDir });
    } else {
      this.browser = await puppeteer.launch(launchOpts);
    }

    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    await this.page.setDefaultTimeout(config.browser.navTimeout);
    await this.page.setDefaultNavigationTimeout(config.browser.navTimeout);

    logger.info('Browser launched', { headless: config.browser.headless });
    return this;
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {
        logger.warn({ err: e.message }, 'Error closing browser');
      }
    }
    this.browser = null;
    this.page = null;
    this._loggedIn = false;
  }

  /**
   * Login CapCut.
   * Strategi:
   *   1. Kalau CAPCUT_USER_DATA_DIR di-set → buka homepage, cek apakah session masih valid (avatar detected).
   *      Kalau valid → langsung skip login.
   *      Kalau tidak valid → throw error "Session expired, run npm run login:manual lagi".
   *   2. Kalau CAPCUT_EMAIL + CAPCUT_PASSWORD di-set → login via form email/password.
   *   3. Kalau keduanya kosong → throw error.
   */
  async login() {
    const hasUserDataDir = !!config.browser.userDataDir;
    const hasEmailCreds = config.capcut.email && config.capcut.password;

    logger.info({
      mode: 'cookie-json → persistent-session → email-password',
      userDataDir: config.browser.userDataDir || null,
    }, 'Logging into CapCut...');

    // === Strategi 0: cookies.json dari /login (shared dengan pure-API) ===
    try {
      const injected = await this._injectCookiesFromJson();
      if (injected) {
        await this.page.goto(config.capcut.baseUrl, { waitUntil: 'domcontentloaded' });
        await sleep(2000);
        if (await this._verifyLoggedIn()) {
          logger.info('Login via cookies.json berhasil (session valid)');
          this._loggedIn = true;
          return;
        }
        logger.warn('cookies.json ada tapi session tidak valid — coba strategi lain');
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'Cookie inject gagal, fallback ke strategi lain');
    }

    if (!hasUserDataDir && !hasEmailCreds) {
      throw new Error(
        'Session CapCut tidak tersedia. Buka /login di browser, paste cookies dari CapCut yang sudah login, lalu coba lagi. (Atau set CAPCUT_EMAIL + CAPCUT_PASSWORD di .env)'
      );
    }

    await this.page.goto(config.capcut.baseUrl, { waitUntil: 'domcontentloaded' });
    await sleep(3000);

    // === Strategi 1: Persistent session (userDataDir) ===
    if (hasUserDataDir) {
      try {
        await this.page.waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: 8000 });
        logger.info('Persistent session valid (avatar detected). Skipping login form.');
        this._loggedIn = true;
        return;
      } catch (_) {
        const currentUrl = this.page.url();
        if (/\/login/.test(currentUrl)) {
          throw new Error(
            'Persistent session expired. Buka /login di browser dan paste cookies fresh dari CapCut.'
          );
        }
        const cookies = await this.browser.cookies();
        const sessionCookies = cookies.filter(c =>
          /session|token|uid|passport|sid/i.test(c.name)
        );
        if (sessionCookies.length > 0) {
          logger.info(
            { cookieNames: sessionCookies.map(c => c.name) },
            'Session cookies ditemukan, mengasumsikan sudah login'
          );
          this._loggedIn = true;
          return;
        }
        throw new Error(
          'Persistent session tidak valid. Buka /login di browser dan paste cookies fresh dari CapCut.'
        );
      }
    }

    // === Strategi 2: Email/password ===
    await this.page.goto(`${config.capcut.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Switch to email login (CapCut default pakai QR/social).
    // NOTE: :has-text() is Playwright syntax, not Puppeteer — we use evaluate() instead.
    try {
      const clicked = await this.page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
        const target = candidates.find(el => {
          const t = (el.innerText || el.textContent || '').toLowerCase();
          return t.includes('email') || t.includes('continue with email');
        });
        if (target) { target.click(); return true; }
        return false;
      });
      if (clicked) await sleep(1000);
    } catch (_) {}

    // Isi email + password
    await this.page.waitForSelector(SELECTORS.emailInput, { timeout: 15000 });
    await this.page.type(SELECTORS.emailInput, config.capcut.email, { delay: 50 });
    await sleep(300);
    await this.page.type(SELECTORS.passwordInput, config.capcut.password, { delay: 50 });
    await sleep(300);

    await this.page.click(SELECTORS.submitLogin);

    // Tunggu redirect / avatar muncul
    try {
      await this.page.waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: 30000 });
      this._loggedIn = true;
      logger.info('Login success (email/password)');
    } catch (e) {
      const bodyText = await this.page.evaluate(() => document.body.innerText.slice(0, 500));
      throw new Error(`Login failed. Page text snippet: ${bodyText.slice(0, 200)}`);
    }
    await sleep(2000);
  }

  /**
   * Tutup semua modal yang nge-block editor (promo, sign-in, dll).
   * CapCut sering banget munculin modal "Dreamina", "Subscribe", dll.
   */
  /** page.$ with hard timeout — CDP can hang on CapCut WebGL pages */
  async _$(sel, ms = 1500) {
    try {
      return await Promise.race([
        this.page.$(sel),
        new Promise((r) => setTimeout(() => r(null), ms)),
      ]);
    } catch (_) {
      return null;
    }
  }

  /**
   * Close modals WITHOUT page.evaluate — evaluate hangs on CapCut WebGL SPA.
   * Only keyboard + short-timeout selector clicks. Hard ceiling ~3s.
   */
  async _closeModals() {
    const clickSel = async (sel, ms = 400) => {
      try {
        const handle = await this._$(sel, ms);
        if (!handle) return false;
        await Promise.race([
          handle.click({ delay: 20 }).catch(() => {}),
          new Promise((r) => setTimeout(r, ms)),
        ]);
        try { await handle.dispose(); } catch (_) {}
        return true;
      } catch (_) {
        return false;
      }
    };

    let closed = 0;
    for (let i = 0; i < 3; i++) {
      try { await this.page.keyboard.press('Escape'); } catch (_) {}
      await sleep(120);
    }
    for (const sel of [
      '.lv-modal-close-icon',
      'button[aria-label="Close"]',
      'button[aria-label="close"]',
      '[class*="modal-close"]',
      '.lv-modal-mask',
    ]) {
      if (await clickSel(sel, 300)) closed++;
    }
    try { await this.page.keyboard.press('Escape'); } catch (_) {}
    if (closed > 0) logger.info({ closed }, 'Closed blocking modals (selector clicks)');
    return closed;
  }

  async _checkEditorSignInModal() {
    try {
      const handle = await this._$(SELECTORS.signInModal, 500);
      if (handle) {
        logger.warn('Sign-in modal selector present — dismissing with Escape');
        await this.page.keyboard.press('Escape').catch(() => {});
        try { await handle.dispose(); } catch (_) {}
      }
    } catch (_) {}
  }


  /**
   * Render template dengan gambar-gambar yang diberikan.
   *
   * @param {Object} template - { id, editorUrl? }
   * @param {string[]} imagePaths - array of local file paths
   * @param {Object} opts - { onProgress: (pct, msg) => void }
   * @returns {Object} { videoBuffer, videoUrl, format }
   */
  async renderTemplate(template, imagePaths, { onProgress } = {}) {
    this._ensureLogin();
    if (!imagePaths?.length) throw new Error('imagePaths required');
    if (!template.id && !template.editorUrl) {
      throw new Error('Template must have id or editorUrl');
    }

    const editorUrl = template.editorUrl ||
      `${config.capcut.baseUrl}/editor-template?create_id=${template.id}`;

    // ⚠️ IMPORTANT: CapCut editor-template route TIDAK menerima prefix region.
    // Pattern lama: /zh-tw/editor-template?create_id=X → 404 Not Found
    // Pattern baru: /editor-template?create_id=X → 200 OK
    // Sanitize editorUrl untuk hapus prefix region.
    const sanitizedEditorUrl = editorUrl.replace(
      /^(https?:\/\/[^/]+)\/[a-z]{2}(?:-[a-z]{2})?\//i,
      '$1/'
    );

    const progress = (pct, msg) => {
      logger.info({ pct, msg }, 'render progress');
      onProgress?.(pct, msg);
    };

    progress(5, 'Opening editor with template');
    await this.page.goto(sanitizedEditorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Cek apakah di-redirect ke login atau 404
    if (/\/login/.test(this.page.url())) {
      throw new Error('Not logged in — redirected to login page. Call login() first.');
    }
    if (await this.page.title().then(t => /404/i.test(t))) {
      throw new Error(`Editor URL returned 404: ${sanitizedEditorUrl}. Template mungkin tidak valid atau URL pattern berubah.`);
    }

    progress(15, 'Waiting editor SPA to load');
    await sleep(4000);

    progress(18, 'Closing blocking modals');
    await Promise.race([this._closeModals(), sleep(3000)]);
    await Promise.race([this._checkEditorSignInModal(), sleep(800)]);

    progress(22, 'Checking editor canvas');
    try {
      await this.page.waitForSelector(SELECTORS.editorReady, { timeout: 8000 });
      progress(28, 'Editor canvas detected');
    } catch (_) {
      logger.warn('Editor ready selector not found within 8s — continuing');
    }

    progress(30, 'Editor ready, uploading images');

    // Upload images via file input — retry sampai 3x kalau input gak langsung muncul
    // (CapCut SPA butuh waktu buat render panel upload setelah editor ready)
    let fileInput = null;
    for (let attempt = 1; attempt <= 3 && !fileInput; attempt++) {
      progress(30 + attempt, `Looking for file input (try ${attempt}/3)`);
      fileInput = await this._$(SELECTORS.fileInput, 2000);
      if (fileInput) break;
      logger.info({ attempt }, 'file input belum muncul, coba trigger upload...');
      const btn = await this._$('button[class*="upload" i], [class*="upload" i] button', 1000);
      if (btn) {
        try { await Promise.race([btn.click({ delay: 20 }), sleep(800)]); } catch (_) {}
        await sleep(600);
      }
      await Promise.race([this._closeModals(), sleep(1200)]);
      fileInput = await this._$(SELECTORS.fileInput, 2000);
      if (!fileInput) await sleep(600);
    }
    if (!fileInput) {
      throw new Error(
        'Upload file input not found in CapCut editor after 3 retries. ' +
        'Editor may still be loading or session incomplete (sign-in overlay).'
      );
    }

    progress(40, 'Uploading images to editor');
    await Promise.race([
      fileInput.uploadFile(...imagePaths),
      sleep(15000).then(() => { throw new Error('uploadFile timeout 15s'); }),
    ]);
    progress(45, 'Images uploaded, waiting for editor to apply');
    await sleep(4000);
    await Promise.race([this._closeModals(), sleep(1500)]);

    // Tutup modal yang mungkin muncul setelah upload (e.g. "Image size too large" warning)
    await this._closeModals();

    // Klik Export / Render — tunggu button AKTIF (tidak disabled)
    progress(60, 'Triggering render/export');
    try {
      // Tunggu sampai button Export tidak disabled (images sudah applied)
      await this.page.waitForSelector(SELECTORS.renderButtonActive, { timeout: 10000 });
    } catch (_) {
      logger.warn('Export button masih disabled atau tidak ketemu. Coba click paksa...');
    }
    const exportBtn = await this._$(SELECTORS.renderButton, 3000);
    if (!exportBtn) {
      throw new Error('Export button tidak ditemukan di editor. UI CapCut mungkin berubah.');
    }
    await exportBtn.click();
    await sleep(2000);

    // Setelah klik Export, mungkin muncul dialog export settings → klik Export/Confirm lagi.
    // NOTE: ganti :has-text() (Playwright-only) dengan evaluate + textContent filter.
    try {
      const clicked = await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const target = btns.find(el => {
          const t = (el.innerText || el.textContent || '').toLowerCase().trim();
          return t === 'export' || t === 'confirm' || t === 'render' || t === 'done';
        });
        if (!target) return false;
        if (target.classList.contains('lv-btn-disabled') || target.disabled) return false;
        target.click();
        return true;
      });
      if (clicked) logger.info('Clicked confirm export button');
    } catch (_) {}
    await this._closeModals();

    // Network intercept — lebih reliable daripada DOM scrape untuk URL video
    progress(75, 'Rendering in progress');
    let downloadUrl = null;
    const capturedUrls = new Set();

    const onResponse = async (res) => {
      try {
        const u = res.url();
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        const status = res.status();
        if (status < 200 || status >= 400) return;
        // CapCut CDN video URLs / content-type video
        if (
          ct.includes('video/') ||
          /\.mp4(\?|$)/i.test(u) ||
          /\/video\/|vod-|\.bytevcloud|capcut\.com.*\.(mp4|m3u8)/i.test(u)
        ) {
          // Skip tiny / preview / thumbnail responses
          const len = parseInt(res.headers()['content-length'] || '0', 10);
          if (len > 0 && len < 50_000) return;
          capturedUrls.add(u);
          if (!downloadUrl) {
            downloadUrl = u;
            logger.info({ url: u.slice(0, 120), ct, len }, 'Captured video URL from network');
          }
        }
      } catch (_) {}
    };
    this.page.on('response', onResponse);

    const start = Date.now();
    const renderTimeout = config.browser.renderTimeout;

    while (!downloadUrl && Date.now() - start < renderTimeout) {
      await sleep(3000);

      // Fallback DOM scrape
      try {
        const domUrl = await this.page.$eval(SELECTORS.renderDone, el => {
          if (el.tagName === 'A' && el.href) return el.href;
          return null;
        }).catch(() => null);
        if (domUrl) {
          downloadUrl = domUrl;
          capturedUrls.add(domUrl);
        }
      } catch (_) {}

      // Progress text
      try {
        const pctText = await this.page.$eval(SELECTORS.renderProgress, el => {
          return el.getAttribute('aria-valuenow') ||
            el.textContent?.match(/(\d+)\s*%/)?.[1] || null;
        }).catch(() => null);
        if (pctText) {
          const pct = parseInt(pctText, 10);
          if (pct < 100) progress(75 + Math.floor(pct * 0.2), `Rendering ${pct}%`);
        }
      } catch (_) {}
    }

    this.page.off('response', onResponse);

    if (!downloadUrl) {
      // Last resort: any captured URL
      const first = [...capturedUrls][0];
      if (first) downloadUrl = first;
    }

    if (!downloadUrl) {
      throw new Error(
        'Render timeout — tidak ada URL video terdeteksi. ' +
        'Coba template lain, atau naikkan RENDER_TIMEOUT. Pastikan session masih valid (cek /login/status).'
      );
    }

    progress(95, 'Downloading rendered video');
    const videoBuffer = await this._downloadVideo(downloadUrl);
    progress(100, 'Done');

    return { videoBuffer, videoUrl: downloadUrl, format: 'mp4' };
  }

  /**
   * Download video via axios menggunakan cookies browser
   */
  async _downloadVideo(url) {
    const client = await this.page.target().createCDPSession();
    const cookies = (await client.send('Network.getAllCookies')).cookies;
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const userAgent = await this.page.evaluate(() => navigator.userAgent);

    const axios = (await import('axios')).default;
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        Cookie: cookieHeader,
        'User-Agent': userAgent,
        Referer: config.capcut.baseUrl,
      },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return Buffer.from(res.data);
  }

  /**
   * Inject cookies from cookies.json (written by POST /login) into the browser.
   * Returns true if cookies were set.
   */
  async _injectCookiesFromJson() {
    const { loadCookies } = await import('../utils/cookie-loader.js');
    const data = await loadCookies();
    if (!data?.all?.length) return false;

    // Puppeteer setCookie needs domain without leading protocol; prefer .capcut.com
    const puppeteerCookies = data.all
      .filter(c => c.name && c.value != null)
      .map(c => {
        let domain = (c.domain || '.capcut.com').replace(/^\./, '');
        if (domain.includes('capcut') || domain.includes('bytedance') || domain.includes('byteoversea')) {
          // keep as-is
        } else {
          domain = 'capcut.com';
        }
        const cookie = {
          name: c.name,
          value: String(c.value),
          domain: domain.startsWith('.') ? domain : `.${domain}`,
          path: c.path || '/',
          secure: c.secure !== false,
          httpOnly: !!c.httpOnly,
        };
        if (c.expires && Number.isFinite(c.expires) && c.expires > 0) {
          cookie.expires = c.expires;
        }
        // sameSite: Puppeteer accepts Strict/Lax/None
        const ss = (c.sameSite || 'Lax').toString();
        cookie.sameSite = ss.charAt(0).toUpperCase() + ss.slice(1).toLowerCase();
        if (!['Strict', 'Lax', 'None'].includes(cookie.sameSite)) cookie.sameSite = 'Lax';
        return cookie;
      });

    if (puppeteerCookies.length === 0) return false;

    // Must be on a matching domain before setting cookies in some Chromium versions
    await this.page.goto(config.capcut.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await this.page.setCookie(...puppeteerCookies);
    logger.info({ count: puppeteerCookies.length }, 'Injected cookies from cookies.json into browser');
    return true;
  }

  /**
   * Verify we appear logged in (avatar, or session cookies present, not on /login).
   */
  async _verifyLoggedIn() {
    const url = this.page.url();
    if (/\/login/.test(url)) return false;
    try {
      await this.page.waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: 5000 });
      return true;
    } catch (_) {
      // fallback: session cookies
      const cookies = await this.browser.cookies();
      return cookies.some(c => /sessionid|sid_tt|passport_csrf/i.test(c.name) && c.value);
    }
  }

  _ensureLogin() {
    if (!this._loggedIn) {
      throw new Error('Browser not logged in. Call login() first. Open /login and paste CapCut cookies.');
    }
  }
}

export default CapCutBrowser;
