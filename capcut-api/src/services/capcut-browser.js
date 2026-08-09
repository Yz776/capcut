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

    if (!hasUserDataDir && !hasEmailCreds) {
      throw new Error(
        'Tidak ada metode login tersedia. Set CAPCUT_USER_DATA_DIR (hasil npm run login:manual) ' +
        'ATAU set CAPCUT_EMAIL + CAPCUT_PASSWORD di .env'
      );
    }

    logger.info({
      mode: hasUserDataDir ? 'persistent-session' : 'email-password',
      userDataDir: config.browser.userDataDir || null,
    }, 'Logging into CapCut...');

    await this.page.goto(config.capcut.baseUrl, { waitUntil: 'domcontentloaded' });
    await sleep(3000);

    // === Strategi 1: Persistent session ===
    if (hasUserDataDir) {
      try {
        await this.page.waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: 8000 });
        logger.info('Persistent session valid (avatar detected). Skipping login form.');
        this._loggedIn = true;
        return;
      } catch (_) {
        // Avatar tidak ketemu. Cek apakah di-redirect ke /login
        const currentUrl = this.page.url();
        if (/\/login/.test(currentUrl)) {
          throw new Error(
            'Persistent session expired. Jalankan ulang: npm run login:manual lalu scan QR baru.'
          );
        }
        // Mungkin avatar selectornya beda. Cek via cookies.
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
          'Persistent session tidak valid (tidak ada cookie session). ' +
          'Jalankan ulang: npm run login:manual'
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
  async _closeModals() {
    const withTimeout = (promise, ms, label) =>
      Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
      ]);

    let closedCount = 0;
    let lastStillVisible = false;
    let stuckModals = [];
    for (let i = 0; i < 5; i++) {
      // Klik tombol close (timeout 3s each)
      try {
        const closeBtn = await withTimeout(this.page.$(SELECTORS.modalClose), 3000, 'modalClose');
        if (closeBtn) {
          await withTimeout(closeBtn.click(), 3000, 'closeBtn.click');
          closedCount++;
          await sleep(500);
          continue;
        }
      } catch (_) {}

      // Klik modal mask
      try {
        const mask = await withTimeout(this.page.$(SELECTORS.modalMask), 3000, 'modalMask');
        if (mask) {
          await withTimeout(mask.evaluate(el => el.click()), 3000, 'mask.click');
          closedCount++;
          await sleep(500);
          continue;
        }
      } catch (_) {}

      // Press Escape
      try {
        await withTimeout(this.page.keyboard.press('Escape'), 3000, 'Escape');
        await sleep(300);
      } catch (_) {}

      // Cek apakah masih ada modal visible (timeout 4s)
      const probe = await withTimeout(
        this.page.evaluate(() => {
          const out = { stillVisible: false, modals: [] };
          const modals = document.querySelectorAll('.lv-modal-mask, .lv-modal-wrapper, [class*="modal" i], [class*="dialog" i]');
          for (const m of modals) {
            if (m.offsetParent !== null && getComputedStyle(m).display !== 'none') {
              out.stillVisible = true;
              out.modals.push({
                cls: (m.className || '').toString().slice(0, 100),
                text: (m.innerText || '').slice(0, 300),
              });
              if (out.modals.length >= 5) break;
            }
          }
          return out;
        }),
        4000,
        'evaluate'
      ).catch(() => ({ stillVisible: false, modals: [] }));
      lastStillVisible = probe.stillVisible;
      stuckModals = probe.modals || [];
      if (!probe.stillVisible) break;
    }
    if (closedCount > 0) {
      logger.info({ closed: closedCount }, 'Closed blocking modals');
    }
    // Diagnostic: if modals still visible after 5 attempts, save screenshot + dump modal info
    if (lastStillVisible) {
      try {
        const tmpDir = path.resolve(process.cwd(), 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const ts = Date.now();
        const shotPath = path.join(tmpDir, `modal-stuck-${ts}.png`);
        await withTimeout(this.page.screenshot({ path: shotPath, fullPage: false }), 5000, 'screenshot');
        logger.warn({ closedCount, stuckModals, screenshot: shotPath, url: this.page.url() }, 'Modals still visible after 5 close attempts');
      } catch (e) {
        logger.warn({ closedCount, stuckModals, error: e.message, url: this.page.url() }, 'Modals stuck + screenshot failed');
      }
    }
    return closedCount;
  }

  /**
   * Cek apakah sign-in modal muncul di editor.
   * Kalau iya, berarti session editor tidak valid — perlu re-login.
   */
  async _checkEditorSignInModal() {
    try {
      const signIn = await this.page.$(SELECTORS.signInModal);
      if (signIn) {
        const visible = await signIn.evaluate(el => el.offsetParent !== null);
        if (visible) {
          throw new Error(
            'Editor menampilkan sign-in modal walaupun passport cookie ada. ' +
            'Session editor tidak lengkap — coba login ulang: npm run login:manual'
          );
        }
      }
    } catch (e) {
      if (e.message.includes('sign-in modal')) throw e;
    }
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

    progress(15, 'Waiting editor SPA to load (heavy)');
    await sleep(15000); // kasih waktu buat WebGL init

    // Tutup modal promo yang sering nge-block editor
    progress(18, 'Closing blocking modals');
    await this._closeModals();

    // Cek apakah sign-in modal muncul = session editor tidak valid
    await this._checkEditorSignInModal();

    try {
      await this.page.waitForSelector(SELECTORS.editorReady, { timeout: 60000 });
    } catch (_) {
      logger.warn('Editor ready selector not found, continuing anyway');
    }

    progress(30, 'Editor ready, uploading images');

    // Upload images via file input — retry sampai 3x kalau input gak langsung muncul
    // (CapCut SPA butuh waktu buat render panel upload setelah editor ready)
    let fileInput = null;
    for (let attempt = 1; attempt <= 3 && !fileInput; attempt++) {
      fileInput = await this.page.$(SELECTORS.fileInput);
      if (fileInput) break;

      logger.info({ attempt }, 'file input belum muncul, coba trigger upload button...');
      try {
        // Click any upload-trigger element (class-based, bukan :has-text)
        const clicked = await this.page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, [class*="upload" i], [class*="import" i]'));
          const target = btns.find(el => {
            const t = (el.innerText || el.textContent || '').toLowerCase();
            const cls = (el.className || '').toString().toLowerCase();
            return t.includes('upload') || t.includes('import') || cls.includes('upload');
          });
          if (target) { target.click(); return true; }
          return false;
        });
        if (clicked) await sleep(1500);
        await this._closeModals();
        fileInput = await this.page.$(SELECTORS.fileInput);
      } catch (e) {
        logger.warn({ err: e.message, attempt }, 'Cannot find upload trigger');
      }
      if (!fileInput) await sleep(2000);
    }
    if (!fileInput) {
      throw new Error('Upload file input not found in CapCut editor after 3 retries. UI CapCut mungkin berubah — jalankan scripts/inspect-editor.js untuk update selector.');
    }

    await fileInput.uploadFile(...imagePaths);
    progress(45, 'Images uploaded, waiting for editor to apply');
    await sleep(15000); // kasih waktu buat process images & apply ke timeline

    // Tutup modal yang mungkin muncul setelah upload (e.g. "Image size too large" warning)
    await this._closeModals();

    // Klik Export / Render — tunggu button AKTIF (tidak disabled)
    progress(60, 'Triggering render/export');
    try {
      // Tunggu sampai button Export tidak disabled (images sudah applied)
      await this.page.waitForSelector(SELECTORS.renderButtonActive, { timeout: 30000 });
    } catch (_) {
      logger.warn('Export button masih disabled atau tidak ketemu. Coba click paksa...');
    }
    const exportBtn = await this.page.$(SELECTORS.renderButton);
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

    // Tunggu progress render selesai
    progress(75, 'Rendering in progress');
    let done = false;
    let downloadUrl = null;
    const start = Date.now();
    const renderTimeout = config.browser.renderTimeout;

    while (!done && Date.now() - start < renderTimeout) {
      await sleep(3000);
      try {
        downloadUrl = await this.page.$eval(SELECTORS.renderDone, el => {
          if (el.tagName === 'A') return el.href;
          return null;
        }).catch(() => null);
      } catch (_) {}

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

      if (downloadUrl) { done = true; break; }
    }

    if (!downloadUrl) {
      throw new Error('Render timeout or no download URL detected');
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

  _ensureLogin() {
    if (!this._loggedIn) {
      throw new Error('Browser not logged in. Call login() first.');
    }
  }
}

export default CapCutBrowser;
