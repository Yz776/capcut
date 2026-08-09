// src/services/capcut-browser.js
import puppeteer from 'puppeteer';
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
  loginButton: 'header a[href*="login"], header button:has-text("Log in"), header button:has-text("登入"), header button:has-text("登錄")',
  emailInput: 'input[type="email"], input[name="email"], input[placeholder*="mail" i]',
  passwordInput: 'input[type="password"], input[name="password"]',
  submitLogin: 'button[type="submit"], button:has-text("Log in"), button:has-text("登入"), button:has-text("登錄")',
  loginSuccessIndicator: '[class*="avatar" i], [data-testid*="user" i]',

  // Editor
  editorReady: '[class*="editor" i], canvas, [class*="track" i]',
  uploadButton: 'button:has-text("Upload"), [class*="upload" i] button',
  fileInput: 'input[type="file"]',
  renderButton: 'button:has-text("Export"), button:has-text("Render"), button:has-text("下載"), button:has-text("匯出")',
  renderProgress: '[class*="progress" i], [role="progressbar"]',
  renderDone: 'a[download], button:has-text("Download"), [class*="download" i] a[href]',
};

export class CapCutBrowser {
  constructor() {
    this.browser = null;
    this.page = null;
    this._loggedIn = false;
    this._langPath = 'zh-tw'; // CapCut default region untuk IP ini
  }

  async launch() {
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
   * Login CapCut pakai email/password.
   * Skip kalau sudah login (cek avatar).
   */
  async login() {
    if (!config.capcut.email || !config.capcut.password) {
      throw new Error('CAPCUT_EMAIL/CAPCUT_PASSWORD not set in env. Cannot login. Alternative: set CAPCUT_USER_DATA_DIR after running npm run login:manual');
    }

    logger.info({ email: config.capcut.email }, 'Logging into CapCut...');
    await this.page.goto(config.capcut.baseUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Cek apakah sudah login (persistent session)
    try {
      await this.page.waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: 5000 });
      logger.info('Already logged in (avatar detected)');
      this._loggedIn = true;
      return;
    } catch (_) {}

    // Klik login button
    await this.page.goto(`${config.capcut.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    // Switch to email login (CapCut default pakai QR/social)
    try {
      const emailTabBtn = await this.page.$('button:has-text("email"), a:has-text("email"), [data-testid*="email" i], div:has-text("Continue with email")');
      if (emailTabBtn) await emailTabBtn.click();
      await sleep(1000);
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
      logger.info('Login success');
    } catch (e) {
      const bodyText = await this.page.evaluate(() => document.body.innerText.slice(0, 500));
      throw new Error(`Login failed. Page text snippet: ${bodyText.slice(0, 200)}`);
    }
    await sleep(2000);
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

    const progress = (pct, msg) => {
      logger.info({ pct, msg }, 'render progress');
      onProgress?.(pct, msg);
    };

    progress(5, 'Opening editor with template');
    await this.page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Cek apakah di-redirect ke login
    if (/\/login/.test(this.page.url())) {
      throw new Error('Not logged in — redirected to login page. Call login() first.');
    }

    progress(20, 'Waiting editor SPA to load (heavy)');
    await sleep(8000);
    try {
      await this.page.waitForSelector(SELECTORS.editorReady, { timeout: 90000 });
    } catch (_) {
      logger.warn('Editor ready selector not found, continuing anyway');
    }

    progress(35, 'Editor ready, uploading images');

    // Upload images via file input
    let fileInput = await this.page.$(SELECTORS.fileInput);
    if (!fileInput) {
      try {
        await this.page.click(SELECTORS.uploadButton);
        await sleep(1000);
        fileInput = await this.page.$(SELECTORS.fileInput);
      } catch (e) {
        logger.warn({ err: e.message }, 'Cannot find upload trigger');
      }
    }
    if (!fileInput) {
      throw new Error('Upload file input not found in CapCut editor. Selector may need update.');
    }

    await fileInput.uploadFile(...imagePaths);
    progress(50, 'Images uploaded, waiting for editor to apply');
    await sleep(10000);

    // Klik Export / Render
    progress(65, 'Triggering render/export');
    await this.page.waitForSelector(SELECTORS.renderButton, { timeout: 30000 });
    await this.page.click(SELECTORS.renderButton);
    await sleep(2000);

    // Pilih kualitas lalu confirm
    try {
      const exportBtn = await this.page.$('button:has-text("Export"), button:has-text("Confirm"), button:has-text("Render"), button:has-text("匯出")');
      if (exportBtn) await exportBtn.click();
    } catch (_) {}

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
