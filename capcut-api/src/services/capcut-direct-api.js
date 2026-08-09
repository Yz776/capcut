// src/services/capcut-direct-api.js
//
// Direct backend client for CapCut internal API.
// NO browser editor needed — pure HTTP/axios calls.
//
// Render pipeline:
//   1. getTemplateFile()    — fetch template draft content
//   2. saveDraft()          — create user-owned draft from template, returns draft_id
//   3. uploadAsset()        — 3-step cloud upload (prepare → PUT → create_cloud_asset)
//   4. patchDraftMaterials()— swap template materials → user asset IDs
//   5. saveDraft()          — persist patched draft
//   6. createRenderTask()   — submit render, returns task_id
//   7. pollRenderTask()     — batch_get until done
//   8. downloadVideo()      — stream MP4 to disk
//
// Auth: cookies from .capcut-profile (logged-in via manual-login.js).
// Required cookies: passport_csrf_token, sessionid, passport, ttwid.

import axios from 'axios';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

// CapCut API hosts (Singapore region for this account)
const HOSTS = {
  EDIT: 'https://edit-api-sg.capcut.com',
  COMMERCE: 'https://commerce-api-sg.capcut.com',
  VCS: 'https://vcs-sg.capcutapi.com',
  WEB: 'https://www.capcut.com',
};

const APP_ID = 348188;

/**
 * CapCut request signature.
 * Algorithm (reverse-engineered from editor bundle-018.js + bundle-035.js):
 *
 *   u = last 7 chars of URL path (or full path if shorter)
 *   sign = md5(`9e2c|${u}|${pf}|${appvr}|${deviceTime}|${tdid}|11ac`).toLowerCase()
 *
 * Verified against real captured request:
 *   path: /cc/v1/workspace/get_user_workspaces
 *   pf=7, appvr=5.8.0, device-time=1786317731, tdid=""
 *   => sign = 05b31d04820ddeb77bad9a583a34f79d ✓
 *
 * @param {string} urlPath - URL pathname (e.g., /cc/v1/workspace/get_user_workspaces)
 * @param {Object} opts - { pf, appvr, tdid, deviceTime }
 * @returns {string} 32-char MD5 hex
 */
function calcSign(urlPath, { pf = '7', appvr = '5.8.0', tdid = '', deviceTime } = {}) {
  const u = urlPath.length >= 7 ? urlPath.slice(-7) : urlPath;
  const ts = deviceTime || Math.floor(Date.now() / 1000);
  const payload = `9e2c|${u}|${pf}|${appvr}|${ts}|${tdid}|11ac`;
  return crypto.createHash('md5').update(payload).digest('hex');
}

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://www.capcut.com/',
  'appid': String(APP_ID),
  'pf': '7',
  'appvr': '5.8.0',
  'loc': 'sg',
  'lan': 'en',
  'sign-ver': '1',
  'app-sdk-version': '48.0.0',
  'store-country-code': 'id',
  'store-country-code-src': 'uid',
  'did': '7671997128840021525', // web/device ID
  'tdid': '',
};

const KNOWN = {
  USER_ID: '7671928449841595410',
  WORKSPACE_ID: '7671929666977923090',
  WEB_ID: '7671997128840021525',
  REGION: 'SG',
};

/**
 * Load cookies from Chrome profile (SQLite).
 * Falls back to puppeteer extraction if direct read fails.
 * @returns {Promise<string>} cookie header string
 */
async function loadCookieHeader() {
  // Lazy-load puppeteer to read cookies (avoids Chrome SQLite encryption complexity)
  const { default: puppeteer } = await import('puppeteer');
  const userDataDir = process.env.CAPCUT_USER_DATA_DIR || path.join(projectRoot, '.capcut-profile');

  // Cleanup stale locks
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(userDataDir, lock), { force: true }); } catch {}
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${HOSTS.WEB}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const cookies = await browser.cookies(HOSTS.WEB, 'https://capcut.com');
    if (cookies.length === 0) {
      throw new Error('No cookies found in profile. Run npm run login:manual first.');
    }
    const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    logger.info({ cookieCount: cookies.length }, 'Loaded cookies from profile');
    return header;
  } finally {
    await browser.close();
  }
}

/**
 * Main CapCut direct API client.
 */
export class CapCutDirectAPI {
  constructor({ workspaceId = KNOWN.WORKSPACE_ID, userId = KNOWN.USER_ID } = {}) {
    this.workspaceId = workspaceId;
    this.userId = userId;
    this.cookieHeader = null;
    this._axios = null;
  }

  async _init() {
    if (this._axios) return;
    this.cookieHeader = await loadCookieHeader();
    this._axios = axios.create({
      headers: { ...DEFAULT_HEADERS, Cookie: this.cookieHeader },
      timeout: 30000,
      validateStatus: s => s < 500, // don't throw on 4xx — handle gracefully
    });

    // Add sign interceptor — computes sign for every request based on URL path.
    // Algorithm: md5(`9e2c|${last7_of_path}|${pf}|${appvr}|${deviceTime}|${tdid}|11ac`)
    this._axios.interceptors.request.use((config) => {
      const url = config.url || '';
      let urlPath;
      try {
        urlPath = new URL(url, config.baseURL || 'https://edit-api-sg.capcut.com').pathname;
      } catch {
        urlPath = url;
      }
      const deviceTime = Math.floor(Date.now() / 1000);
      const pf = config.headers?.pf || DEFAULT_HEADERS.pf;
      const appvr = config.headers?.appvr || DEFAULT_HEADERS.appvr;
      const tdid = config.headers?.tdid ?? DEFAULT_HEADERS.tdid;

      config.headers = {
        ...config.headers,
        'device-time': String(deviceTime),
        'sign': calcSign(urlPath, { pf, appvr, tdid, deviceTime }),
      };
      return config;
    });

    logger.info({ workspaceId: this.workspaceId }, 'CapCutDirectAPI initialized (with sign interceptor)');
  }

  /**
   * Step 1: Get template file (draft content from template).
   * @param {string} templateId
   * @returns {Promise<Object>} template draft content
   */
  async getTemplateFile(templateId) {
    await this._init();
    logger.info({ templateId }, 'getTemplateFile');
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/editor/draft/get_template_file`,
      { template_id: templateId, enter_from: 'template_editor' }
    );
    return this._unwrap(res.data);
  }

  /**
   * Step 1b: Get template detail (plane editor format).
   */
  async getTemplateDetail(templateId) {
    await this._init();
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/cc_web/plane/get_template_detail`,
      { template_id: templateId, enter_from: 'template_editor' }
    );
    return this._unwrap(res.data);
  }

  /**
   * Step 1c: Multi-get templates (metadata).
   */
  async multiGetTemplates(templateIds) {
    await this._init();
    const ids = Array.isArray(templateIds) ? templateIds : [templateIds];
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/cc_web/replicate/multi_get_templates`,
      {
        biz_id: null,
        id: ids,
        enter_from: 'template_editor',
        sdk_version: '127.0.0',
        cc_web_version: 0,
      }
    );
    return this._unwrap(res.data);
  }

  /**
   * Step 2: Save draft (create or update).
   * @param {Object} content - draft content (from getTemplateFile or modified)
   * @param {Object} opts - { draft_id?: string, video_name?: string }
   * @returns {Promise<{draft_id: string, ...}>}
   */
  async saveDraft(content, { draftId, videoName } = {}) {
    await this._init();
    logger.info({ draftId, hasContent: !!content }, 'saveDraft');
    const body = {
      workspace_id: this.workspaceId,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      draft_id: draftId || '',
      video_name: videoName || 'CapCut Render',
      platform: 'web',
      sdk_version: '127.0.0',
    };
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/editor/plane_draft/save`,
      body
    );
    return this._unwrap(res.data);
  }

  /**
   * Step 2b: Get draft detail.
   */
  async getDraftDetail(draftId) {
    await this._init();
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/editor/plane_draft/get_draft_detail`,
      { draft_id: draftId, workspace_id: this.workspaceId }
    );
    return this._unwrap(res.data);
  }

  /**
   * Step 3: Upload asset (3-step cloud upload).
   * @param {string} filePath - local file path
   * @returns {Promise<{asset_id, video_id, file_url, ...}>}
   */
  async uploadAsset(filePath) {
    await this._init();
    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.png' ? 'image/png'
      : ext === '.mp4' ? 'video/mp4'
      : 'application/octet-stream';

    logger.info({ fileName, sizeKB: Math.round(stat.size / 1024) }, 'uploadAsset: prepare');
    // Step 3a: prepare upload
    const prepareRes = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/asset/prepare_upload_cloud`,
      {
        workspace_id: this.workspaceId,
        file_name: fileName,
        file_size: stat.size,
        content_type: contentType,
        is_web_user: true,
      }
    );
    const prepareData = this._unwrap(prepareRes.data);
    const uploadUrl = prepareData.upload_url || prepareData.UploadAddress?.upload_url;
    const uploadToken = prepareData.upload_token || prepareData.upload_token || prepareData.UploadToken;
    const storeUri = prepareData.store_uri || prepareData.StoreUri;

    if (!uploadUrl) {
      logger.error({ prepareData }, 'uploadAsset: no upload_url in prepare response');
      throw new Error('prepare_upload_cloud did not return upload_url');
    }

    // Step 3b: PUT file bytes to cloud storage
    logger.info({ uploadUrl: uploadUrl.slice(0, 80) }, 'uploadAsset: PUT bytes');
    const fileBuf = fs.readFileSync(filePath);
    const putRes = await axios.put(uploadUrl, fileBuf, {
      headers: { 'Content-Type': contentType, 'Content-Length': stat.size },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    logger.info({ putStatus: putRes.status }, 'uploadAsset: PUT done');

    // Step 3c: create cloud asset
    const createRes = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/asset/create_cloud_asset`,
      {
        workspace_id: this.workspaceId,
        file_name: fileName,
        upload_token: uploadToken,
        store_uri: storeUri,
        content_type: contentType,
        file_size: stat.size,
        is_web_user: true,
      }
    );
    const assetData = this._unwrap(createRes.data);
    logger.info({ assetId: assetData.asset_id, videoId: assetData.video_id }, 'uploadAsset: done');
    return assetData;
  }

  /**
   * Step 4: Patch draft materials — swap template materials with user assets.
   * This is template-specific; implementation depends on draft content structure.
   *
   * @param {Object} draftContent - parsed draft content from getTemplateFile
   * @param {Array<{asset_id, video_id, file_url}>} userAssets - uploaded assets
   * @param {Object} opts - { materialIndices?: number[] } which materials to replace (default: all image materials)
   * @returns {Object} patched draft content
   */
  patchDraftMaterials(draftContent, userAssets, { materialIndices } = {}) {
    // CapCut draft content typically has:
    //   content.materials.videos[]  — video material slots
    //   content.materials.images[]  — image material slots (what we want to replace)
    //   content.materials.audios[]
    //   content.tracks[]            — timeline tracks referencing materials by ID
    //
    // For templates with N image slots, we replace materials.images[i] with userAssets[i].

    if (!draftContent || typeof draftContent !== 'object') {
      throw new Error('Invalid draft content');
    }

    // Deep clone to avoid mutating input
    const patched = JSON.parse(JSON.stringify(draftContent));
    const materials = patched.materials || (patched.materials = {});
    const images = materials.images || (materials.images = []);

    logger.info(
      { imageSlots: images.length, userAssets: userAssets.length, materialIndices },
      'patchDraftMaterials'
    );

    // Determine which slots to replace
    const indicesToReplace = materialIndices
      ? materialIndices
      : images.map((_, i) => i).slice(0, userAssets.length);

    for (let i = 0; i < indicesToReplace.length && i < userAssets.length; i++) {
      const idx = indicesToReplace[i];
      const asset = userAssets[i];
      if (idx >= images.length) {
        logger.warn({ idx, imageCount: images.length }, 'patchDraftMaterials: index out of range, skipping');
        continue;
      }

      // Preserve existing material ID & duration, swap the source URL/asset_id
      const existing = images[idx] || {};
      images[idx] = {
        ...existing,
        // Common fields across CapCut versions
        asset_id: asset.asset_id || existing.asset_id,
        video_id: asset.video_id || existing.video_id,
        file_url: asset.file_url || asset.url || existing.file_url,
        url: asset.file_url || asset.url || existing.url,
        source: 'cloud',
        // Keep existing material_id so tracks still reference correctly
        material_id: existing.material_id,
      };
    }

    return patched;
  }

  /**
   * Step 6: Create render task.
   * @param {Object} opts
   *   - draft_id (required)
   *   - video_name (default 'CapCut Render')
   *   - definition (default '1080p') — 480p/720p/1080p
   *   - width, height, fps (defaults from template)
   *   - format (default 'mp4')
   * @returns {Promise<{task_id, submit_id}>}
   */
  async createRenderTask({
    draftId,
    videoName = 'CapCut Render',
    definition = '1080p',
    width = 1080,
    height = 1920,
    fps = 30,
    format = 'mp4',
    duration = 10000,
    cover = '',
  } = {}) {
    await this._init();
    if (!draftId) throw new Error('draftId required');

    const submitId = `${Date.now()}_${Math.random()}`;
    const body = {
      app_version: '1.0.0.285',
      sdk_version: '127.0.0',
      extra: '{}',
      type: 0,
      region: KNOWN.REGION,
      app_id: APP_ID,
      width,
      height,
      fps,
      format,
      cover,
      duration,
      quality: 100,
      definition,
      task_id: '',
      video_name: videoName,
      draft_id: draftId,
      package_id: '',
      video_id: '',
      video_path: '',
      group_id: '',
      custom_info: '{}',
      from_workspace_id: this.workspaceId,
      to_workspace_id: this.workspaceId,
      force_export: false,
      submit_id: submitId,
    };

    logger.info({ draftId, definition, videoName, submitId }, 'createRenderTask');
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/render_task/create`,
      body
    );
    const data = this._unwrap(res.data);
    return {
      task_id: data.task_id,
      submit_id: submitId,
      raw: data,
    };
  }

  /**
   * Step 7: Poll render task status.
   * @param {string} taskId
   * @param {Object} opts - { intervalMs, timeoutMs, onProgress }
   * @returns {Promise<{status, video_url, progress, raw}>}
   */
  async pollRenderTask(taskId, {
    intervalMs = 3000,
    timeoutMs = 300000,
    onProgress = null,
  } = {}) {
    await this._init();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await this._axios.post(
        `${HOSTS.EDIT}/lv/v1/render_task/batch_get`,
        { task_ids: [taskId] }
      );
      const data = this._unwrap(res.data);
      const taskInfo = (data.tasks || data.task_list || [])[0] || data;
      const status = taskInfo.status || taskInfo.state;
      const progress = taskInfo.progress || 0;
      const videoUrl = taskInfo.video_url || taskInfo.video?.url || taskInfo.download_url;

      logger.info({ taskId, status, progress, hasUrl: !!videoUrl }, 'pollRenderTask');

      if (onProgress) {
        try { onProgress({ status, progress, videoUrl }); } catch {}
      }

      // Status values: 0=waiting, 1=processing, 2=success, 3=failed, 4=canceled (typical)
      if (status === 2 || status === 'success' || status === 'done' || status === 'completed') {
        if (!videoUrl) {
          logger.warn({ taskInfo }, 'pollRenderTask: status done but no video URL');
        }
        return {
          status: 'completed',
          progress: 100,
          video_url: videoUrl,
          raw: taskInfo,
        };
      }
      if (status === 3 || status === 'failed' || status === 'error') {
        throw new Error(`Render failed: ${JSON.stringify(taskInfo)}`);
      }
      if (status === 4 || status === 'canceled') {
        throw new Error('Render canceled');
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Render timeout after ${timeoutMs}ms`);
  }

  /**
   * Step 8: Download video to local file.
   * @param {string} url - video URL from pollRenderTask
   * @param {string} outPath - local file path
   */
  async downloadVideo(url, outPath) {
    logger.info({ url: url.slice(0, 80), outPath }, 'downloadVideo');
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: 300000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { 'User-Agent': DEFAULT_HEADERS['User-Agent'] },
    });
    const ws = fs.createWriteStream(outPath);
    return new Promise((resolve, reject) => {
      res.data.pipe(ws);
      ws.on('finish', () => {
        logger.info({ outPath, size: ws.bytesWritten }, 'downloadVideo: done');
        resolve({ outPath, size: ws.bytesWritten });
      });
      ws.on('error', reject);
      res.data.on('error', reject);
    });
  }

  /**
   * Cancel a render task.
   */
  async cancelRenderTask(taskId) {
    await this._init();
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/render_task/cancel`,
      { task_id: taskId }
    );
    return this._unwrap(res.data);
  }

  /**
   * Get user workspaces.
   */
  async getWorkspaces() {
    await this._init();
    const res = await this._axios.post(
      `${HOSTS.EDIT}/cc/v1/workspace/get_user_workspaces`,
      { cursor: '0', count: 100, need_convert_workspace: true }
    );
    return this._unwrap(res.data);
  }

  /**
   * Get account info (validates session).
   */
  async getAccountInfo() {
    await this._init();
    const res = await this._axios.get(`${HOSTS.WEB}/passport/web/account/info/`);
    return res.data;
  }

  /**
   * Unwrap CapCut API response.
   * CapCut returns {ret, errmsg, data, log_id} or {code, message, data}.
   */
  _unwrap(resData) {
    if (!resData || typeof resData !== 'object') {
      throw new Error(`Invalid response: ${typeof resData}`);
    }
    // Format 1: {ret: "0", errmsg, data, log_id}
    if ('ret' in resData) {
      const ret = String(resData.ret);
      if (ret !== '0') {
        const err = new Error(`CapCut API error: ret=${ret} errmsg=${resData.errmsg || ''} log_id=${resData.log_id || ''}`);
        err.ret = ret;
        err.errmsg = resData.errmsg;
        err.log_id = resData.log_id;
        throw err;
      }
      return resData.data || {};
    }
    // Format 2: {code: 0, message, data}
    if ('code' in resData) {
      if (resData.code !== 0) {
        const err = new Error(`CapCut API error: code=${resData.code} message=${resData.message || ''}`);
        err.code = resData.code;
        err.message = resData.message;
        throw err;
      }
      return resData.data || {};
    }
    // Already unwrapped
    return resData;
  }
}

export default CapCutDirectAPI;
