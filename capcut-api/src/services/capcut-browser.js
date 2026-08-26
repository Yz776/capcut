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

  async _uploadImages(imagePaths, progress) {
    const absPaths = imagePaths.map((p) => path.resolve(p));
    progress?.(32, 'Upload strategy: existing file inputs');
    try {
      const inputs = await Promise.race([
        this.page.$$('input[type="file"]'),
        sleep(2500).then(() => []),
      ]);
      if (inputs?.length) {
        logger.info({ count: inputs.length }, 'Found file input(s)');
        await Promise.race([
          inputs[0].uploadFile(...absPaths),
          sleep(12000).then(() => { throw new Error('uploadFile timeout'); }),
        ]);
        return { ok: true, via: 'file-input' };
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'Strategy 1 file-input failed');
    }
    progress?.(34, 'Upload strategy: file chooser triggers');
    for (const sel of [
      '[class*="upload" i]', '[class*="import" i]', '[data-testid*="upload" i]',
      'button[class*="media" i]', '[class*="add-media" i]', '[class*="replace" i]',
      '[class*="placeholder" i]', '[class*="empty-slot" i]', '[class*="material-slot" i]',
      '[class*="slot-item" i]', '[class*="media-card" i]',
    ]) {
      try {
        const el = await this._$(sel, 800);
        if (!el) continue;
        const chooserPromise = this.page.waitForFileChooser({ timeout: 2500 }).catch(() => null);
        await Promise.race([el.click({ delay: 30 }), sleep(800)]);
        const chooser = await chooserPromise;
        if (chooser) {
          await chooser.accept(absPaths);
          return { ok: true, via: 'file-chooser', sel };
        }
        const inputs = await Promise.race([this.page.$$('input[type="file"]'), sleep(1000).then(() => [])]);
        if (inputs?.length) {
          await inputs[0].uploadFile(...absPaths);
          return { ok: true, via: 'file-input-after-click', sel };
        }
      } catch (_) {}
    }
    progress?.(36, 'Upload strategy: slot clicks');
    try {
      const candidates = await Promise.race([
        this.page.$$('[class*="replace" i], [class*="placeholder" i], [class*="slot" i], [class*="segment" i] img, [class*="track" i] img'),
        sleep(2000).then(() => []),
      ]);
      for (const el of (candidates || []).slice(0, 8)) {
        try {
          const chooserPromise = this.page.waitForFileChooser({ timeout: 2000 }).catch(() => null);
          await Promise.race([el.click({ delay: 20 }), sleep(600)]);
          const chooser = await chooserPromise;
          if (chooser) {
            await chooser.accept([absPaths[0]]);
            for (let i = 1; i < absPaths.length; i++) {
              const c2 = this.page.waitForFileChooser({ timeout: 2000 }).catch(() => null);
              await Promise.race([el.click({ delay: 20 }), sleep(500)]);
              const ch = await c2;
              if (ch) await ch.accept([absPaths[i]]);
            }
            return { ok: true, via: 'slot-chooser' };
          }
        } catch (_) {}
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'slot strategy failed');
    }
    progress?.(38, 'Upload strategy: CDP setFileInputFiles');
    try {
      const client = await this.page.createCDPSession();
      const { root } = await Promise.race([
        client.send('DOM.getDocument', { depth: -1 }),
        sleep(3000).then(() => ({ root: null })),
      ]);
      if (root?.nodeId) {
        const { nodeId } = await client.send('DOM.querySelector', {
          nodeId: root.nodeId, selector: 'input[type=file]',
        }).catch(() => ({ nodeId: 0 }));
        if (nodeId) {
          await client.send('DOM.setFileInputFiles', { nodeId, files: absPaths });
          return { ok: true, via: 'cdp' };
        }
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'CDP upload failed');
    }
    return { ok: false, via: null };
  }

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
    await sleep(3000);
    await Promise.race([this._closeModals(), sleep(1500)]);
    const uploadResult = await this._uploadImages(imagePaths, progress);
    if (!uploadResult.ok) {
      throw new Error(
        'Could not upload images into CapCut editor (no file input / file chooser). ' +
        'Try HEADLESS=false + login:manual, or use engine=local.'
      );
    }
    logger.info({ via: uploadResult.via }, 'Images uploaded into editor');
    progress(45, `Images uploaded via ${uploadResult.via}`);
    await sleep(4000);
    await Promise.race([this._closeModals(), sleep(1500)]);

        progress(60, 'Triggering render/export');
    await sleep(2000);
    await Promise.race([this._closeModals(), sleep(1000)]);
    let exportClicked = false;
    try {
      await this.page.waitForSelector(SELECTORS.renderButtonActive, { timeout: 8000 }).catch(() => null);
      const exportBtn = await this._$(SELECTORS.renderButton, 2500);
      if (exportBtn) {
        await Promise.race([exportBtn.click({ delay: 40 }), sleep(1500)]);
        exportClicked = true;
        logger.info('Clicked export via class selector');
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'class export click failed');
    }
    if (!exportClicked) {
      try {
        const clicked = await Promise.race([
          this.page.evaluate(() => {
            const soft = /export|render|download|导出|匯出/i;
            const btns = [...document.querySelectorAll('button, [role="button"], a')];
            const target = btns.find(el => soft.test((el.innerText || '').trim()) && el.offsetParent);
            if (!target) return false;
            target.click();
            return true;
          }),
          new Promise((r) => setTimeout(() => r(false), 3000)),
        ]);
        if (clicked) { exportClicked = true; logger.info('Clicked export via text'); }
      } catch (_) {}
    }
    if (!exportClicked) logger.warn('Export button not found — listening for video URL anyway');
    await sleep(1500);
    try {
      const clicked = await Promise.race([
        this.page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const target = btns.find(el => /^(export|confirm|render|done|ok)$/i.test((el.innerText || '').trim()));
          if (!target || target.disabled) return false;
          target.click();
          return true;
        }),
        new Promise((r) => setTimeout(() => r(false), 2500)),
      ]);
      if (clicked) logger.info('Clicked confirm export');
    } catch (_) {}
    await Promise.race([this._closeModals(), sleep(1000)]);

    progress(70, 'Watching network for video URL');
    let downloadUrl = null;
    const capturedUrls = new Set();
    const jsonHints = [];

    // Real CapCut export CDN example (user-verified):
    // https://v16-cc.capcut.com/.../video/tos/alisg/tos-alisg-ve-.../...?mime_type=video_mp4&a=348188
    const looksLikeVideoUrl = (u, ct = '', len = 0) => {
      if (!u || typeof u !== 'string') return false;
      if (u.startsWith('blob:')) return false;
      const low = u.toLowerCase();
      // exclude obvious non-export assets
      if (/draft_cover|thumbnail|sprite|cover_|\/cover\.|\/icon|_preview|watermark_only/i.test(low)) return false;

      const isCapcutVideoHost =
        /v\d+-cc\.capcut\.com/i.test(low) ||
        /v\d+-capcut/i.test(low) ||
        /capcutcdn/i.test(low) ||
        /bytevcloud/i.test(low) ||
        /ibyteimg/i.test(low) ||
        /capcut\.com\/.*\/video\//i.test(low);

      // Known export hosts: never reject on small content-length (redirects often have len~0)
      if (!isCapcutVideoHost && len > 0 && len < 80_000) return false;

      if (ct.includes('video/')) return true;
      if (/mime_type=video_mp4/i.test(low)) return true;
      if (/\.mp4(\?|$)/i.test(low)) return true;
      if (isCapcutVideoHost && /\/video\/|\/media\/|tos-.*-ve-|vod-/i.test(low)) return true;
      if (/\/media\/|\/video\/|vod-|bytevcloud|capcutcdn|ibyteimg|tos-.*-ve-|\.m3u8/i.test(low)) return true;
      return false;
    };

    const extractUrlFromJson = (text) => {
      if (!text || text.length > 2_000_000) return null;
      try {
        const urls = text.match(/https?:\/\/[^"\\s]+\.mp4[^"\\s]*/gi) || [];
        for (const u of urls) {
          if (looksLikeVideoUrl(u)) return u.replace(/[\\]+$/,'');
        }
        const m =
          text.match(/"(?:video_url|download_url|play_url|url|videoUrl|video_path|downloadUrl|playUrl|file_url)"\s*:\s*"(https?:[^"]+)"/i) ||
          text.match(/"(https?:\/\/[^"]+\.mp4[^"]*)"/i);
        if (m) return m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      } catch (_) {}
      return null;
    };

    const onResponse = async (res) => {
      try {
        const u = res.url();
        const status = res.status();
        const headers = res.headers() || {};
        const ct = (headers['content-type'] || '').toLowerCase();
        const len = parseInt(headers['content-length'] || '0', 10);
        // Follow redirect Location (CapCut CDN often 302 → v16-cc.capcut.com)
        if (status >= 300 && status < 400) {
          const loc = headers['location'] || headers['Location'];
          if (loc && looksLikeVideoUrl(loc, '', 0)) {
            capturedUrls.add(loc);
            if (!downloadUrl) {
              downloadUrl = loc;
              logger.info({ url: loc.slice(0, 140), via: 'redirect' }, 'Captured video URL from redirect');
            }
          }
        }
        if (status < 200 || status >= 400) return;

        if (looksLikeVideoUrl(u, ct, len)) {
          capturedUrls.add(u);
          if (!downloadUrl) {
            downloadUrl = u;
            logger.info({ url: u.slice(0, 140), ct, len, status }, 'Captured video URL from network');
          }
          return;
        }

        if (ct.includes('json') || /render|export|compose|download|get_video|play_info/i.test(u)) {
          let text = '';
          try { text = await res.text(); } catch (_) { return; }
          const found = extractUrlFromJson(text);
          if (found) {
            capturedUrls.add(found);
            if (!downloadUrl) {
              downloadUrl = found;
              logger.info({ url: found.slice(0, 140), from: u.slice(0, 80) }, 'Captured video URL from JSON');
            }
          } else if (text && /render|export|task/i.test(u)) {
            jsonHints.push({ u: u.slice(0, 100), preview: text.slice(0, 120) });
          }
        }
      } catch (_) {}
    };
    this.page.on('response', onResponse);

    let cdp;
    try {
      cdp = await this.page.createCDPSession();
      await cdp.send('Network.enable');
      cdp.on('Network.responseReceived', (evt) => {
        try {
          const u = evt?.response?.url || '';
          const ct = (evt?.response?.mimeType || '').toLowerCase();
          const headers = evt?.response?.headers || {};
          const loc = headers['location'] || headers['Location'];
          if (loc && looksLikeVideoUrl(loc, '', 0)) {
            capturedUrls.add(loc);
            if (!downloadUrl) {
              downloadUrl = loc;
              logger.info({ url: loc.slice(0, 140) }, 'CDP captured redirect video URL');
            }
          }
          if (looksLikeVideoUrl(u, ct)) {
            capturedUrls.add(u);
            if (!downloadUrl) {
              downloadUrl = u;
              logger.info({ url: u.slice(0, 140) }, 'CDP captured video URL');
            }
          }
        } catch (_) {}
      });
      cdp.on('Network.requestWillBeSent', (evt) => {
        try {
          const u = evt?.request?.url || '';
          if (looksLikeVideoUrl(u, '', 0)) {
            capturedUrls.add(u);
            if (!downloadUrl) {
              downloadUrl = u;
              logger.info({ url: u.slice(0, 140) }, 'CDP captured video URL (request)');
            }
          }
        } catch (_) {}
      });
    } catch (e) {
      logger.warn({ err: e.message }, 'CDP Network.enable failed');
    }

    progress(75, 'Rendering in progress');
    const start = Date.now();
    const renderTimeout = config.browser.renderTimeout || 300000;

    while (!downloadUrl && Date.now() - start < renderTimeout) {
      await sleep(2000);
      const elapsed = Date.now() - start;
      progress(75 + Math.min(20, Math.floor(elapsed / renderTimeout * 20)), `Waiting export video (${Math.round(elapsed/1000)}s)`);

      try {
        const domUrl = await Promise.race([
          this.page.evaluate(() => {
            const as = [...document.querySelectorAll('a[download], a[href*=".mp4"], video source, video')];
            for (const el of as) {
              const href = el.href || el.src || el.getAttribute('src');
              if (href && /\.mp4|video/i.test(href) && !href.startsWith('blob:')) return href;
            }
            return null;
          }),
          sleep(1500).then(() => null),
        ]);
        if (domUrl) {
          downloadUrl = domUrl;
          capturedUrls.add(domUrl);
        }
      } catch (_) {}

      if (!downloadUrl && elapsed < 60000 && elapsed > 8000 && Math.floor(elapsed / 2000) % 8 === 0) {
        try {
          await Promise.race([
            this.page.evaluate(() => {
              const soft = /export|confirm|done|ok|download/i;
              const btn = [...document.querySelectorAll('button')].find(b =>
                soft.test((b.innerText || '').trim()) && !b.disabled);
              if (btn) btn.click();
            }),
            sleep(1500),
          ]);
        } catch (_) {}
      }
    }

    this.page.off('response', onResponse);
    try { if (cdp) cdp.removeAllListeners('Network.responseReceived'); } catch (_) {}

    if (!downloadUrl) {
      const first = [...capturedUrls][0];
      if (first) downloadUrl = first;
    }

    if (!downloadUrl) {
      logger.warn({ jsonHints: jsonHints.slice(-5), captured: [...capturedUrls].slice(0, 5) }, 'No video URL after wait');
      throw new Error(
        'Render timeout — tidak ada URL video terdeteksi setelah export. ' +
        'Session editor mungkin tidak lengkap atau export tidak terpicu di headless. ' +
        'Gunakan engine=local atau login:manual (HEADLESS=false).'
      );
    }

    progress(95, 'Downloading rendered video');
    let videoBuffer;
    if (downloadUrl.startsWith('blob:')) {
      const arr = await Promise.race([
        this.page.evaluate(async (url) => {
          const r = await fetch(url);
          const ab = await r.arrayBuffer();
          return Array.from(new Uint8Array(ab));
        }, downloadUrl),
        sleep(60000).then(() => { throw new Error('blob download timeout'); }),
      ]);
      videoBuffer = Buffer.from(arr);
    } else {
      videoBuffer = await this._downloadVideo(downloadUrl);
    }
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
