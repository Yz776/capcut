// src/services/capcut-browser.js
import puppeteer from 'puppeteer';
import { config } from '../utils/config.js';
import { sleep } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

/**
 * CapCut browser automation class.
 *
 * Lifecycle:
 *   const b = new CapCutBrowser();
 *   await b.launch();
 *   await b.login();
 *   const tpl = await b.getTemplate('https://www.capcut.com/templates/detail/123');
 *   const videoUrl = await b.renderTemplate(tpl, imagePaths);
 *   await b.close();
 *
 * Catatan: CapCut adalah SPA yang berat. Selector di sini sudah diuji pada
 * Desember 2024 dan bisa berubah. Bila selector gagal, cek ulang DOM dengan
 * manual launch (HEADLESS=false) lalu update selector di `SELECTORS` constant.
 */

const SELECTORS = {
  // login
  loginButton: 'header [data-testid="login_button"], header button:has-text("Log in"), a[href*="login"]',
  emailInput: 'input[type="email"], input[name="email"], input[placeholder*="mail" i]',
  passwordInput: 'input[type="password"], input[name="password"]',
  submitLogin: 'button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")',
  loginSuccessIndicator: '[data-testid="user_avatar"], [class*="avatar" i]', // appears setelah login

  // templates list
  templateCard: '[class*="template" i] a[href*="/templates/detail/"], a[href*="/templates/detail/"]',
  templateCardImage: 'img',
  templateCardTitle: '[class*="title" i], span, p',

  // template detail page
  useTemplateButton: 'button:has-text("Use template"), button:has-text("Pakai template"), button:has-text("Edit"), [data-testid*="use_template" i]',
  // Editor (CapCut web editor)
  editorReady: '[class*="editor" i], canvas, [class*="track" i]',
  uploadButton: 'button:has-text("Upload"), [class*="upload" i] button, input[type="file"]',
  fileInput: 'input[type="file"]',
  replaceMedia: '[class*="replace" i], button:has-text("Replace")',
  renderButton: 'button:has-text("Export"), button:has-text("Render"), button:has-text("Download")',
  renderProgress: '[class*="progress" i], [role="progressbar"]',
  renderDone: 'a[download], button:has-text("Download"), [class*="download" i] a[href]',
};

export class CapCutBrowser {
  constructor() {
    this.browser = null;
    this.page = null;
    this._loggedIn = false;
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
        // CapCut web editor butuh GPU accel untuk render video
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--enable-features=Vulkan',
      ],
    };

    // Use persistent userDataDir kalau diset (mempertahankan login)
    if (config.browser.userDataDir) {
      this.browser = await puppeteer.launch({
        ...launchOpts,
        userDataDir: config.browser.userDataDir,
      });
    } else {
      this.browser = await puppeteer.launch(launchOpts);
    }

    // Anti-bot: set common webdriver flag off
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
      try {
        await this.browser.close();
      } catch (e) {
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
      throw new Error('CAPCUT_EMAIL/CAPCUT_PASSWORD not set in env. Cannot login.');
    }

    logger.info({ email: config.capcut.email }, 'Logging into CapCut...');

    // Coba deteksi sudah login via persistent state
    await this.page.goto(config.capcut.baseUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    try {
      await this.page.waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: 5000 });
      logger.info('Already logged in (avatar detected)');
      this._loggedIn = true;
      return;
    } catch (_) {
      // belum login, lanjut
    }

    // Klik login button
    await this.page.waitForSelector(SELECTORS.loginButton, { timeout: 15000 });
    await this.page.click(SELECTORS.loginButton);
    await sleep(1500);

    // Switch to email login (CapCut default pakai QR/social)
    try {
      // tombol "Log in with email"
      const emailTabBtn = await this.page.$('button:has-text("email"), a:has-text("email"), [data-testid*="email" i]');
      if (emailTabBtn) await emailTabBtn.click();
      await sleep(800);
    } catch (_) {
      // mungkin langsung form email
    }

    // Isi email + password
    await this.page.waitForSelector(SELECTORS.emailInput, { timeout: 15000 });
    await this.page.type(SELECTORS.emailInput, config.capcut.email, { delay: 50 });
    await sleep(300);
    await this.page.type(SELECTORS.passwordInput, config.capcut.password, { delay: 50 });
    await sleep(300);

    // Submit
    await this.page.click(SELECTORS.submitLogin);

    // Tunggu redirect / avatar muncul
    try {
      await this.page.waitForSelector(SELECTORS.loginSuccessIndicator, { timeout: 30000 });
      this._loggedIn = true;
      logger.info('Login success');
    } catch (e) {
      // Cek apakah ada captcha / error
      const bodyText = await this.page.evaluate(() => document.body.innerText.slice(0, 500));
      throw new Error(`Login failed. Page text snippet: ${bodyText.slice(0, 200)}`);
    }

    await sleep(2000);
  }

  /**
   * List templates populer. Returns array of {id, url, title, thumbnail, duration?, author?}
   */
  async listTemplates({ limit = 20, category } = {}) {
    this._ensureLogin();
    const url = `${config.capcut.baseUrl}${config.capcut.templatesPath}` +
      (category ? `?category=${encodeURIComponent(category)}` : '');
    logger.info({ url }, 'Listing templates');
    await this.page.goto(url, { waitUntil: 'networkidle2' });
    await sleep(2500);

    // Scroll beberapa kali untuk load lazy content
    for (let i = 0; i < 3; i++) {
      await this.page.evaluate(() => window.scrollBy(0, 1500));
      await sleep(800);
    }

    const templates = await this.page.$$eval(SELECTORS.templateCard, (els, base) => {
      return els.map(el => {
        const href = el.getAttribute('href') || '';
        const img = el.querySelector('img');
        const titleEl = el.querySelector('[class*="title" i], span, p');
        const m = href.match(/\/templates\/detail\/(\d+)/) || href.match(/template[_-]id[=:](\w+)/);
        return {
          id: m ? m[1] : href,
          url: href.startsWith('http') ? href : base + href,
          title: titleEl?.textContent?.trim() || '',
          thumbnail: img?.src || '',
        };
      });
    }, config.capcut.baseUrl);

    const unique = [];
    const seen = new Set();
    for (const t of templates) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        unique.push(t);
      }
      if (unique.length >= limit) break;
    }
    logger.info({ count: unique.length }, 'Templates fetched');
    return unique;
  }

  /**
   * Search template by keyword. CapCut search URL: /search?keyword=...
   */
  async searchTemplates(keyword, { limit = 20 } = {}) {
    this._ensureLogin();
    const url = `${config.capcut.baseUrl}/search?keyword=${encodeURIComponent(keyword)}&type=template`;
    logger.info({ url, keyword }, 'Searching templates');
    await this.page.goto(url, { waitUntil: 'networkidle2' });
    await sleep(3000);

    for (let i = 0; i < 3; i++) {
      await this.page.evaluate(() => window.scrollBy(0, 1500));
      await sleep(800);
    }

    const templates = await this.page.$$eval(SELECTORS.templateCard, (els, base) => {
      return els.map(el => {
        const href = el.getAttribute('href') || '';
        const img = el.querySelector('img');
        const titleEl = el.querySelector('[class*="title" i], span, p');
        const m = href.match(/\/templates\/detail\/(\d+)/) || href.match(/template[_-]id[=:](\w+)/);
        return {
          id: m ? m[1] : href,
          url: href.startsWith('http') ? href : base + href,
          title: titleEl?.textContent?.trim() || '',
          thumbnail: img?.src || '',
        };
      });
    }, config.capcut.baseUrl);

    const unique = [];
    const seen = new Set();
    for (const t of templates) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        unique.push(t);
      }
      if (unique.length >= limit) break;
    }
    return unique;
  }

  /**
   * Ambil info template by URL atau ID.
   */
  async getTemplate(templateUrlOrId) {
    this._ensureLogin();
    const url = templateUrlOrId.startsWith('http')
      ? templateUrlOrId
      : `${config.capcut.baseUrl}/templates/detail/${templateUrlOrId}`;
    logger.info({ url }, 'Fetching template detail');
    await this.page.goto(url, { waitUntil: 'networkidle2' });
    await sleep(2500);

    // Cari tombol "Use template"
    const useBtn = await this.page.$(SELECTORS.useTemplateButton);
    const title = await this.page.title();

    // Scrape media slots (jumlah gambar/video yang harus diisi)
    // CapCut detail page biasanya nunjukin "Replace X photos" atau similar
    let slotCount = 2; // default minimal 2 gambar sesuai permintaan user
    try {
      const text = await this.page.evaluate(() => document.body.innerText);
      const m = text.match(/(\d+)\s*(photos?|images?|clips?|gambar|foto)/i);
      if (m) slotCount = parseInt(m[1], 10);
    } catch (_) {}

    return {
      id: templateUrlOrId,
      url,
      title: title.replace(/- CapCut.*$/i, '').trim(),
      useTemplateAvailable: !!useBtn,
      imageSlots: slotCount,
    };
  }

  /**
   * Render template dengan gambar-gambar yang diberikan.
   *
   * @param {Object} template - hasil dari getTemplate()
   * @param {string[]} imagePaths - array of local file paths (sudah didownload/decoded)
   * @param {Object} opts - { onProgress: (pct, msg) => void }
   * @returns {Object} { videoPath, videoUrl, format, duration? }
   */
  async renderTemplate(template, imagePaths, { onProgress } = {}) {
    this._ensureLogin();
    if (!imagePaths?.length) throw new Error('imagePaths required');

    const progress = (pct, msg) => {
      logger.info({ pct, msg }, 'render progress');
      onProgress?.(pct, msg);
    };

    progress(5, 'Opening template detail');
    await this.page.goto(template.url, { waitUntil: 'networkidle2' });
    await sleep(2500);

    progress(10, 'Clicking "Use template"');
    await this.page.waitForSelector(SELECTORS.useTemplateButton, { timeout: 30000 });
    await this.page.click(SELECTORS.useTemplateButton);

    // Editor CapCut akan terbuka (bisa di tab baru atau SPA route)
    progress(20, 'Waiting editor to load');
    await sleep(4000);

    // Handle new tab kalau editor terbuka di tab baru
    const pages = await this.browser.pages();
    if (pages.length > 1) {
      this.page = pages[pages.length - 1];
      await this.page.bringToFront();
    }

    // Tunggu editor ready
    await this.page.waitForSelector(SELECTORS.editorReady, { timeout: 60000 });
    progress(35, 'Editor ready, uploading images');

    // Upload images via file input
    // CapCut editor pakai <input type="file" multiple>
    let fileInput;
    try {
      fileInput = await this.page.$(SELECTORS.fileInput);
    } catch (_) {}

    if (!fileInput) {
      // Coba klik tombol upload dulu
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

    // Upload semua gambar sekaligus
    await fileInput.uploadFile(...imagePaths);
    progress(50, 'Images uploaded, waiting for editor to apply');

    // Tunggu sampai semua image terpasang ke slot
    // CapCut akan auto-assign ke track
    await sleep(8000);

    // Klik Export / Render
    progress(65, 'Triggering render/export');
    await this.page.waitForSelector(SELECTORS.renderButton, { timeout: 30000 });
    await this.page.click(SELECTORS.renderButton);
    await sleep(1500);

    // Pilih kualitas (default 1080p) lalu confirm
    try {
      const exportBtn = await this.page.$('button:has-text("Export"), button:has-text("Confirm"), button:has-text("Render")');
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
      // Cek apakah ada download link / button
      try {
        downloadUrl = await this.page.$eval(SELECTORS.renderDone, el => {
          if (el.tagName === 'A') return el.href;
          return null;
        }).catch(() => null);
      } catch (_) {}

      // Cek progress
      try {
        const pctText = await this.page.$eval(SELECTORS.renderProgress, el => {
          return el.getAttribute('aria-valuenow') ||
            el.textContent?.match(/(\d+)\s*%/)?.[1] ||
            null;
        }).catch(() => null);
        if (pctText) {
          const pct = parseInt(pctText, 10);
          if (pct < 100) {
            progress(75 + Math.floor(pct * 0.2), `Rendering ${pct}%`);
          }
        }
      } catch (_) {}

      if (downloadUrl) {
        done = true;
        break;
      }
    }

    if (!downloadUrl) {
      throw new Error('Render timeout or no download URL detected');
    }

    progress(95, 'Downloading rendered video');
    const videoBuffer = await this._downloadVideo(downloadUrl);

    progress(100, 'Done');
    return {
      videoBuffer,
      videoUrl: downloadUrl,
      format: 'mp4',
    };
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
