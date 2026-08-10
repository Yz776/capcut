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
function calcSign(urlPath, { pf = '7', appvr = '15.4.0', tdid = 'web', deviceTime } = {}) {
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
  // appvr=15.4.0 and app-sdk-version=127.0.0 are the values the real CapCut web editor sends
  // (verified from runtime capture api-capture-v3.jsonl, seq 83). Older values (5.8.0/48.0.0)
  // worked for /cc/v1/workspace/get_user_workspaces but newer endpoints reject them.
  'appvr': '15.4.0',
  'loc': 'sg',
  'lan': 'en-US',
  'sign-ver': '1',
  'app-sdk-version': '127.0.0',
  'store-country-code': 'id',
  'store-country-code-src': 'uid',
  'did': '7671997128840021525', // web/device ID
  'tdid': 'web',
};

const KNOWN = {
  USER_ID: '7671928449841595410',
  WORKSPACE_ID: '7671929666977923090',
  WEB_ID: '7671997128840021525',
  REGION: 'SG',
};

/**
 * Load cookies from Chrome profile (cached, shared across services).
 * Uses src/utils/cookie-loader.js to avoid spawning puppeteer on every call.
 * @returns {Promise<{header: string, csrfToken: string|null, all: Object[]}>}
 */
async function loadCookieHeader() {
  const { loadCookies } = await import('../utils/cookie-loader.js');
  const data = await loadCookies();
  return {
    header: data.header,
    csrfToken: data.csrfToken,
    all: data.all,
  };
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
    const cookieData = await loadCookieHeader();
    this.cookieHeader = cookieData.header;
    this.csrfToken = cookieData.csrfToken;
    this.allCookies = cookieData.all;

    // Detect login status — if sessionid is missing, session is expired.
    const hasSession = cookieData.all.some(c => c.name === 'sessionid' || c.name === 'sid_tt');
    if (!hasSession) {
      logger.warn('Session appears EXPIRED — sessionid/sid_tt cookie missing. API calls will fail with ret=1015 notLogin. Refresh via POST /login.');
    }

    const baseHeaders = {
      ...DEFAULT_HEADERS,
      Cookie: this.cookieHeader,
      'withCredentials': 'true',
    };
    if (this.csrfToken) {
      baseHeaders['x-tt-passport-csrf-token'] = this.csrfToken;
    }

    this._axios = axios.create({
      headers: baseHeaders,
      timeout: 30000,
      validateStatus: s => s < 500, // don't throw on 4xx — handle gracefully
    });

    // Add sign interceptor — computes sign for every request based on URL path.
    // Algorithm: md5(`9e2c|${last7_of_path}|${pf}|${appvr}|${deviceTime}|${tdid}|11ac`)
    // Per bundle-035.js: sign uses tdid="" (empty), NOT "web".
    // We override tdid to "" for the SIGN computation only (header still sends "web" for compat).
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
      // For sign computation, use empty tdid (matches bundle-035.js py interceptor)
      const tdidForSign = '';

      config.headers = {
        ...config.headers,
        'device-time': String(deviceTime),
        'sign': calcSign(urlPath, { pf, appvr, tdid: tdidForSign, deviceTime }),
      };
      return config;
    });

    logger.info({ workspaceId: this.workspaceId, hasCsrf: !!this.csrfToken, hasSession }, 'CapCutDirectAPI initialized (with sign + csrf)');
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
   *
   * VERIFIED body schema (from bundle-035.js offset 451051 + live test on production):
   *   - package_key: the draft ID (we generate this, e.g. timestamp + random)
   *   - template_data: the draft JSON serialized as a string
   *   - template_meta: JSON.stringify({draft, uploadSource, createSource})
   *   - package_type: 5 (constant for plane drafts)
   *   - base_package_id: "0" for first save, ticket value for updates
   *   - package_assets/referenced_assets: arrays of {source_path, md5, size}
   *   - materials: the materials object
   *   - user_actions: "{}"
   *   - cover_image_content: base64 (without data: prefix)
   *   - page_covers: array of {data, source_path}
   *
   * KEY: The server returns a `package_id` (different from package_key).
   * Use the ORIGINAL package_key for get_draft_detail.
   * Use BOTH package_key (as draft_id) AND returned package_id for render_task/create.
   *
   * @param {Object} content - draft content object (will be JSON.stringified as template_data)
   * @param {Object} opts - { packageKey?, videoName?, materials?, coverBase64? }
   * @returns {Promise<{package_key: string, package_id: string, raw: Object}>}
   */
  async saveDraft(content, { packageKey, videoName, materials, coverBase64, packageAssets } = {}) {
    await this._init();
    // Generate package_key if not provided
    const pkgKey = packageKey || String(Date.now()) + Math.floor(Math.random() * 1000);
    logger.info({ packageKey: pkgKey, hasContent: !!content }, 'saveDraft');

    const draftData = typeof content === 'string' ? content : JSON.stringify(content);
    const meta = {
      draft: {
        id: pkgKey,
        name: videoName || 'CapCut Render',
        type: 5,
        duration: 0,
        updateTime: Date.now(),
        size: draftData.length,
        segmentCount: 0,
        version: '1.0.0',
        platformSupport: 'browser',
        isMainTrackEmpty: !content?.tracks?.length,
        isScriptTemplate: false,
        renderIndexTrackMode: false,
        canvasInfo: {
          width: content?.canvas_config?.width || 1080,
          height: content?.canvas_config?.height || 1920,
          sizeUnit: 'px',
          pageInfoList: [{
            width: content?.canvas_config?.width || 1080,
            height: content?.canvas_config?.height || 1920,
            sizeUnit: 'px',
            unit: 'px',
          }],
        },
        coverUrl: 'cover.jpg',
        cover: 'cover.jpg',
        graphicInfo: { isUseInCn: false, isBatch: false },
      },
      uploadSource: {
        owner: this.userId,
        platform: 'browser',
        systemVersion: 'Mozilla/5.0',
        appVersion: '1.0.0',
        createTime: Date.now(),
      },
      createSource: {
        owner: this.userId,
        platform: 'browser',
        systemVersion: 'Mozilla/5.0',
        appVersion: '1.0.0',
        createTime: Date.now(),
      },
    };

    const body = {
      workspace_id: this.workspaceId,
      package_type: 5,
      package_key: pkgKey,
      base_package_id: '0',
      template_data: draftData,
      template_meta: JSON.stringify(meta),
      package_assets: packageAssets || [],
      referenced_assets: packageAssets || [],
      materials: materials || content?.materials || {},
      user_actions: '{}',
      cover_image_content: coverBase64 || '',
      page_covers: coverBase64 ? [{ data: coverBase64, source_path: 'cover.jpg' }] : [],
    };

    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/editor/plane_draft/save`,
      body
    );
    const data = this._unwrap(res.data);
    return {
      package_key: pkgKey,        // the ORIGINAL key we generated — use for get_draft_detail
      package_id: data.package_id, // the server-assigned ID — use for render_task/create
      raw: data,
    };
  }

  /**
   * Step 2b: Get draft detail.
   *
   * KEY: Use the ORIGINAL package_key (the one we generated in saveDraft),
   * NOT the package_id returned by saveDraft.
   *
   * Body schema (from bundle-035.js):
   *   {package_key, app_version, sdk_version, lang, region, workspace_id, package_asset_limit:30}
   */
  async getDraftDetail(packageKey) {
    await this._init();
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/editor/plane_draft/get_draft_detail`,
      {
        package_key: packageKey,
        app_version: '5.8.0',
        sdk_version: '16.1.0',
        lang: 'en-US',
        region: 'ID',
        workspace_id: this.workspaceId,
        package_asset_limit: 30,
      }
    );
    return this._unwrap(res.data);
  }

  /**
   * Step 3: Upload asset via pure-API VOD upload (NO BROWSER NEEDED).
   *
   * VERIFIED WORKING pipeline (from vod-uploader.js uploadFileVOD):
   *   1. POST /lv/v1/upload_sign {key_version:'v5', biz:'replicate'} → STS token + space_name
   *   2. GET vod-ap-singapore-1.bytevcloudapi.com ApplyUploadInner → StoreUri, Auth, UploadHost, SessionKey
   *   3. POST https://<UploadHost>/<StoreUri> with body=file bytes, Content-CRC32:"ignore" → upload hash
   *   4. POST vod-ap-singapore-1.bytevcloudapi.com CommitUploadInner with body {SessionKey, Functions:[]}
   *      → returns Vid + VideoMeta.Uri
   *
   * The returned `vid` is what gets used as `asset.video_id` in draft materials,
   * and `uri` is what gets used as `asset.file_url`/`asset.url`.
   *
   * @param {string} filePath - local file path
   * @returns {Promise<{vid: string, uri: string, video_id: string, file_url: string, url: string, md5: string, fileSize: number, width: number, height: number, spaceName: string, raw: Object}>}
   */
  async uploadAsset(filePath) {
    await this._init();
    const { uploadFileVOD } = await import('./vod-uploader.js');
    const result = await uploadFileVOD(this, filePath, {
      biz: 'replicate',
      userId: this.userId,
    });
    // Map to the field names expected by saveDraft/patchDraftMaterials
    return {
      vid: result.vid,
      uri: result.uri,
      video_id: result.vid,
      file_url: result.uri,
      url: result.uri,
      asset_id: result.vid,  // VOD Vid serves as asset_id for create_cloud_asset-style flow
      md5: result.md5,
      fileSize: result.fileSize,
      width: result.width,
      height: result.height,
      spaceName: result.spaceName,
      raw: result.raw,
    };
  }

  /**
   * Step 3b: Register uploaded VOD asset as a CapCut cloud asset.
   *
   * CapCut's draft save expects materials.video_id to reference an asset registered
   * in their cloud asset system, NOT a raw VOD vid. This method calls:
   *   1. POST /lv/v1/asset/prepare_upload_cloud {workspace_id, space_id:"0", md5, size, file_type, flags}
   *      → returns {upload_id, everphoto_user_id, state}
   *   2. POST /lv/v1/asset/create_cloud_asset {everphoto_id, asset:{...}, is_web_user:true}
   *      → returns {cloud_asset:{asset_id}, cloud_file_entry:{entry_id}}
   *
   * Reverse-engineered from bundle-035.js (prepareUpload + createAsset in I.p namespace).
   *
   * @param {Object} uploadResult - result from uploadAsset()
   * @param {string} filePath - local file path (for size/md5 if needed)
   * @returns {Promise<{asset_id: string, entry_id: string, upload_id: string, everphoto_user_id: string}>}
   */
  async registerCloudAsset(uploadResult, filePath) {
    await this._init();
    const fs = await import('node:fs');
    const crypto = await import('node:crypto');
    const path = await import('node:path');

    const fileBuf = fs.readFileSync(filePath);
    const md5 = uploadResult.md5 || crypto.createHash('md5').update(fileBuf).digest('hex');
    const size = uploadResult.fileSize || fileBuf.length;
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const fileType = (ext === 'mp4' || ext === 'mov') ? 'video' : 'image';

    logger.info({ md5, size, fileName, fileType, vid: uploadResult.vid }, 'registerCloudAsset: prepare_upload_cloud');

    // === Step 1: prepare_upload_cloud ===
    const prepareBody = {
      workspace_id: this.workspaceId,
      space_id: '0',
      md5,
      size,
      file_type: fileType,
      flags: 0,
      is_web_user: true,
    };
    const prepareRes = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/asset/prepare_upload_cloud`,
      prepareBody
    );
    const prepareData = this._unwrap(prepareRes.data);
    logger.info({ prepareData: JSON.stringify(prepareData).slice(0, 500) }, 'registerCloudAsset: prepare_upload_cloud response');

    const uploadId = prepareData.upload_id;
    const everphotoUserId = prepareData.everphoto_user_id;
    const state = prepareData.state;

    // If state === 'SUCCESS', file already exists on cloud, skip actual upload.
    // We've already uploaded via VOD, so we pass the VOD uri to create_cloud_asset.
    logger.info({ uploadId, everphotoUserId, state }, 'registerCloudAsset: prepared');

    // === Step 2: create_cloud_asset ===
    const assetInfo = {
      size,
      workspace_id: this.workspaceId,
      filename: fileName,
      upload_id: uploadId,
      preserve_video_multi_definition: false,
      if_image_async_resize: true,
      transcode_template_type: 0,
      permission: 0,
      space_id: '0',
      flags: 0,
      file_type: fileType,
      folder_id: '',
      meta: JSON.stringify({ vid: uploadResult.vid }),
      md5,
      no_copy: false,
      // uri is required when file was uploaded externally (our VOD upload case)
      uri: uploadResult.uri,
    };

    const createBody = {
      everphoto_id: everphotoUserId || '',
      asset: assetInfo,
      is_web_user: true,
    };

    logger.info({ createBody: JSON.stringify(createBody).slice(0, 500) }, 'registerCloudAsset: create_cloud_asset');

    const createRes = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/asset/create_cloud_asset`,
      createBody
    );
    const createData = this._unwrap(createRes.data);
    logger.info({ createData: JSON.stringify(createData).slice(0, 500) }, 'registerCloudAsset: create_cloud_asset response');

    return {
      asset_id: createData.cloud_asset?.asset_id,
      entry_id: createData.cloud_file_entry?.entry_id,
      upload_id: uploadId,
      everphoto_user_id: everphotoUserId,
      raw: createData,
    };
  }

  /**
   * Step 3c: Full upload + register pipeline.
   * Convenience method that does uploadAsset() + registerCloudAsset().
   *
   * @param {string} filePath - local file path
   * @returns {Promise<Object>} combined result with all fields needed for saveDraft
   */
  async uploadAndRegisterAsset(filePath) {
    await this._init();
    logger.info({ filePath }, 'uploadAndRegisterAsset: starting');

    const uploaded = await this.uploadAsset(filePath);
    logger.info({ vid: uploaded.vid }, 'uploadAndRegisterAsset: VOD upload done, registering cloud asset...');

    let cloudAsset;
    try {
      cloudAsset = await this.registerCloudAsset(uploaded, filePath);
      logger.info({ assetId: cloudAsset.asset_id }, 'uploadAndRegisterAsset: cloud asset registered');
    } catch (e) {
      logger.warn({ err: e.message, vid: uploaded.vid }, 'registerCloudAsset failed — using VOD vid as fallback asset_id');
      cloudAsset = { asset_id: uploaded.vid, entry_id: null, upload_id: null, everphoto_user_id: null };
    }

    return {
      ...uploaded,
      ...cloudAsset,
      // The cloud_asset.asset_id is what should be used in materials.video_id
      cloud_asset_id: cloudAsset.asset_id,
    };
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
   *
   * VERIFIED body schema (from bundle-018.js offset 96764 + live test on production):
   *   - BOTH draft_id AND package_id are required for the task to be created.
   *   - draft_id = the ORIGINAL package_key we generated in saveDraft()
   *   - package_id = the package_id returned by saveDraft()
   *   - NO submit_id field (that's for a different endpoint, createExportTask)
   *   - If only draft_id or only package_id is provided, returns ret=1000 "param error".
   *
   * @param {Object} opts
   *   - draftId (required) — the original package_key from saveDraft
   *   - packageId (required) — the package_id returned by saveDraft
   *   - videoName (default 'CapCut Render')
   *   - definition (default '720p') — 480p/720p/1080p
   *   - width, height, fps (defaults: 1080x1920 @ 30fps)
   *   - format (default 'mp4')
   *   - duration (default 10000, in ms)
   * @returns {Promise<{task_id, miss_materials, raw}>}
   */
  async createRenderTask({
    draftId,
    packageId,
    videoName = 'CapCut Render',
    definition = '720p',
    width = 1080,
    height = 1920,
    fps = 30,
    format = 'mp4',
    duration = 10000,
    cover = '',
  } = {}) {
    await this._init();
    if (!draftId) throw new Error('draftId required (use the original package_key from saveDraft)');
    if (!packageId) throw new Error('packageId required (use the package_id returned by saveDraft)');

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
      package_id: packageId,
      video_id: '',
      video_path: '',
      group_id: '',
      custom_info: '{}',
      from_workspace_id: this.workspaceId,
      to_workspace_id: this.workspaceId,
      force_export: false,
    };

    logger.info({ draftId, packageId, definition, videoName }, 'createRenderTask');
    const res = await this._axios.post(
      `${HOSTS.EDIT}/lv/v1/render_task/create`,
      body
    );
    const data = this._unwrap(res.data);
    if (String(data.task_id) === '0') {
      throw new Error(`render_task/create returned task_id=0 (not created). ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
    }
    return {
      task_id: data.task_id,
      miss_materials: data.miss_materials,
      raw: data,
    };
  }

  /**
   * Step 7: Poll render task status.
   *
   * VERIFIED response format (from live test on production):
   *   The batch_get response data is a DICT keyed by task_id, e.g.:
   *   { "7672189146483589121": { id, status, progress, video_url, ... } }
   *
   * Status values observed:
   *   0  = waiting/queued
   *   1  = processing (progress 1-99)
   *   2  = success (video_url will be set)
   *   -1 = failed (check render_ret_code / task_err_code)
   *   4  = canceled
   *
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
      // Response format variations:
      //   - data[taskId] = {id, status, progress, video_url, ...} (dict keyed by task_id)
      //   - data.render_task = {id, status, ...} (single task)
      //   - data.render_task[taskId] = {...} (dict under render_task key)
      //   - data.tasks[] = [...] (array)
      //   - data.task_list[] = [...] (array)
      //   - data itself = {status, id, ...} (already unwrapped)
      let taskInfo = null;
      if (data && typeof data === 'object' && data[taskId]) {
        taskInfo = data[taskId];
      } else if (data?.render_task) {
        if (Array.isArray(data.render_task)) {
          taskInfo = data.render_task[0];
        } else if (data.render_task[taskId]) {
          taskInfo = data.render_task[taskId];
        } else {
          taskInfo = data.render_task;
        }
      } else if (Array.isArray(data.tasks) && data.tasks.length > 0) {
        taskInfo = data.tasks[0];
      } else if (Array.isArray(data.task_list) && data.task_list.length > 0) {
        taskInfo = data.task_list[0];
      } else if (data && (data.status !== undefined || data.id)) {
        taskInfo = data;
      }

      if (!taskInfo) {
        logger.warn({ taskId, dataKeys: Object.keys(data || {}) }, 'pollRenderTask: no task info found');
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }

      const status = taskInfo.status ?? taskInfo.state;
      const progress = taskInfo.progress || 0;
      const videoUrl = taskInfo.video_url || taskInfo.video?.url || taskInfo.download_url;

      logger.info({ taskId, status, progress, hasUrl: !!videoUrl }, 'pollRenderTask');

      if (onProgress) {
        try { onProgress({ status, progress, videoUrl, raw: taskInfo }); } catch {}
      }

      // Status: 2=success, -1=failed, 4=canceled
      if (status === 2 || status === 'success' || status === 'done' || status === 'completed') {
        return {
          status: 'completed',
          progress: 100,
          video_url: videoUrl,
          raw: taskInfo,
        };
      }
      if (status === -1 || status === 3 || status === 'failed' || status === 'error') {
        const errMsg = `Render failed: status=${status} ret_code=${taskInfo.render_ret_code || ''} err_code=${taskInfo.task_err_code || ''}`;
        const err = new Error(errMsg);
        err.taskInfo = taskInfo;
        throw err;
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
