// src/routes/direct-render.js
//
// Pure-API render pipeline (NO browser editor for the render step).
//
// Pipeline:
//   1. Upload image(s) via VOD → /lv/v1/upload_sign + VOD upload + CommitUploadInner
//   2. Register as CapCut cloud asset → /lv/v1/asset/prepare_upload_cloud + create_cloud_asset
//   3. Build draft JSON with materials.videos[] populated
//   4. Save draft → /lv/v1/editor/plane_draft/save → returns package_key + package_id
//   5. Create render task → /lv/v1/render_task/create → returns task_id
//   6. Poll render task → /lv/v1/render_task/batch_get → returns video_url
//   7. Download video → save to /videos/ → return public URL
//
// If session is expired (ret=1015), returns clear error with link to /login.
//
// Body (JSON or multipart):
//   {
//     "images": ["/path/to/local.jpg"] | ["https://..."] | ["data:image/jpeg;base64,..."],
//     "videoName": "My Render"  // optional
//   }
// Or multipart/form-data with field "images" (multiple files)

import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { nanoid } from 'nanoid';
import { CapCutDirectAPI } from '../services/capcut-direct-api.js';
import { parseMultipart } from '../utils/multipart.js';
import { createJob, enqueueJob, getJob, STATES } from '../services/job-manager.js';
import { sanitizeFilename } from '../utils/paths.js';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const app = new Hono();

// Local image resolver — accepts 1+ images, supports URL/base64/local-path
async function resolveLocalImages(jsonBody, files) {
  const out = [];
  const tmpDir = path.join(config.storage.tmpDir, 'images', nanoid(10));
  fs.mkdirSync(tmpDir, { recursive: true });

  // Multipart files
  if (files && files.length > 0) {
    for (const f of files) {
      const ext = path.extname(f.filename) || '.jpg';
      const dest = path.join(tmpDir, `upload_${out.length}${ext}`);
      fs.copyFileSync(f.filepath, dest);
      out.push(dest);
    }
  }

  if (jsonBody) {
    const arr = jsonBody.images || jsonBody.imageUrls || jsonBody.imagesBase64;
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (typeof item === 'string') {
          if (item.startsWith('http')) {
            try {
              const ext = path.extname(new URL(item).pathname).toLowerCase() || '.jpg';
              const dest = path.join(tmpDir, `dl_${i}${ext}`);
              const res = await axios.get(item, {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
              });
              fs.writeFileSync(dest, Buffer.from(res.data));
              out.push(dest);
            } catch (e) {
              logger.warn({ url: item, err: e.message }, 'Failed to download image');
            }
          } else if (item.startsWith('data:')) {
            const m = item.match(/^data:image\/(\w+);base64,(.+)$/);
            if (m) {
              const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
              const dest = path.join(tmpDir, `b64_${i}.${ext}`);
              fs.writeFileSync(dest, Buffer.from(m[2], 'base64'));
              out.push(dest);
            }
          } else if (fs.existsSync(item)) {
            out.push(item);
          }
        }
      }
    }
  }

  return out;
}

/**
 * POST /render-direct
 *
 * Body:
 *   { "images": ["localpath|url|dataURI", ...], "videoName": "..." }
 *
 * Response 202:
 *   { "jobId": "...", "status": "queued", "statusUrl": "/render-direct/status/..." }
 */
app.post('/', async (c) => {
  let imagePaths;
  let videoName;
  let jsonBody = null;

  const contentType = c.req.header('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const nodeReq = c.env.incoming;
    const { fields, files } = await parseMultipart(nodeReq);
    videoName = fields.videoName || fields.name;
    imagePaths = await resolveLocalImages(null, files);
  } else {
    try {
      jsonBody = await c.req.json();
    } catch (e) {
      return c.json({ error: 'Invalid JSON body', detail: e.message }, 400);
    }
    videoName = jsonBody.videoName || jsonBody.name;
    imagePaths = await resolveLocalImages(jsonBody, null);
  }

  if (!imagePaths || imagePaths.length === 0) {
    return c.json({
      error: 'At least one image required.',
      hint: 'Provide images via JSON {images:[...]} or multipart form with field "images".',
    }, 400);
  }

  const job = createJob({
    videoName: videoName || 'Direct Render',
    imageCount: imagePaths.length,
    pipeline: 'direct-api',
  });

  enqueueJob(job, async (j) => {
    await runDirectRenderJob(j, { imagePaths, videoName });
  });

  return c.json({
    jobId: job.id,
    status: job.status,
    statusUrl: `/render-direct/status/${job.id}`,
    downloadUrl: `/render-direct/download/${job.id}`,
    pipeline: 'direct-api (no browser editor for render step)',
  }, 202);
});

/**
 * GET /render-direct/status/:jobId
 */
app.get('/status/:jobId', (c) => {
  const job = getJob(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    videoUrl: job.videoUrl,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });
});

/**
 * GET /render-direct/download/:jobId
 */
app.get('/download/:jobId', (c) => {
  const job = getJob(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.status !== STATES.COMPLETED) {
    return c.json({
      error: 'Job not completed yet',
      status: job.status,
      progress: job.progress,
      message: job.message,
    }, 409);
  }
  return c.redirect(job.videoUrl);
});

// ====== Render pipeline ======

async function runDirectRenderJob(job, { imagePaths, videoName }) {
  const setProgress = (pct, msg) => {
    job.progress = pct;
    job.message = msg;
    job.updatedAt = Date.now();
  };

  const api = new CapCutDirectAPI();

  try {
    setProgress(2, 'Initializing API client & loading cookies');
    await api._init();

    // Early login check
    if (!api.allCookies?.some(c => c.name === 'sessionid' || c.name === 'sid_tt')) {
      throw new Error(
        'SESSION_EXPIRED: CapCut session has expired. ' +
        'Open /login in browser and paste fresh cookies from a logged-in CapCut session.'
      );
    }

    setProgress(5, `Uploading ${imagePaths.length} asset(s) via VOD`);
    const assets = [];
    for (let i = 0; i < imagePaths.length; i++) {
      const imgPath = imagePaths[i];
      setProgress(5 + Math.floor((i / imagePaths.length) * 20), `Uploading asset ${i + 1}/${imagePaths.length}: ${path.basename(imgPath)}`);
      const uploaded = await api.uploadAndRegisterAsset(imgPath);
      logger.info({ idx: i, vid: uploaded.vid, assetId: uploaded.cloud_asset_id }, 'Asset uploaded & registered');
      assets.push(uploaded);
    }

    setProgress(30, 'Building draft JSON with materials');
    const draftId = String(Date.now()) + Math.floor(Math.random() * 1000);
    const packageAssets = assets.map((a, i) => ({
      source_path: path.basename(imagePaths[i]),
      md5: a.md5,
      size: a.fileSize,
    }));

    // Prefer golden fixture from capture-oneshot.js (real CapCut save body).
    // Ini jalur paling efisien: replay body yang sudah lolos validasi server.
    let draftData;
    let materialsOverride;
    let packageAssetsOverride = packageAssets;
    const fixture = loadCapturedSaveFixture(assets, { draftId });
    if (fixture) {
      logger.info({ src: fixture.source }, 'Using captured plane_draft/save fixture');
      draftData = fixture.content;
      materialsOverride = fixture.materials;
      packageAssetsOverride = fixture.packageAssets || packageAssets;
      setProgress(35, 'Draft dari capture fixture (golden path)');
    } else {
      draftData = buildDraft(assets, { draftId, videoName: videoName || 'CapCut Render' });
      materialsOverride = draftData.materials;
      setProgress(35, 'Draft dari buildDraft schema (experimental)');
    }

    const tmpDir = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, `draft-${draftId}.json`), JSON.stringify(draftData, null, 2));

    setProgress(40, 'Saving draft to CapCut');
    const saveResult = await api.saveDraft(draftData, {
      packageKey: draftId,
      videoName: videoName || 'CapCut Render',
      materials: materialsOverride,
      packageAssets: packageAssetsOverride,
    });
    logger.info({ packageKey: saveResult.package_key, packageId: saveResult.package_id }, 'Draft saved');
    setProgress(55, `Draft saved (package_id: ${saveResult.package_id})`);

    setProgress(60, 'Creating render task');
    const renderTask = await api.createRenderTask({
      draftId: saveResult.package_key,
      packageId: saveResult.package_id,
      videoName: videoName || 'CapCut Render',
      definition: '720p',
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 5_000_000,
    });
    logger.info({ taskId: renderTask.task_id }, 'Render task created');
    setProgress(65, `Render task created (task_id: ${renderTask.task_id})`);

    setProgress(70, 'Polling render task (this can take 1-5 minutes)');
    const renderResult = await api.pollRenderTask(renderTask.task_id, {
      intervalMs: 5000,
      timeoutMs: 300_000,
      onProgress: ({ status, progress, videoUrl }) => {
        setProgress(70 + Math.floor(progress * 0.25), `Render ${status} ${progress}%${videoUrl ? ' (URL ready)' : ''}`);
      },
    });
    logger.info({ videoUrl: renderResult.video_url }, 'Render completed');
    setProgress(95, 'Downloading rendered video');

    const outPath = path.join(process.cwd(), 'videos', `${sanitizeFilename(videoName || 'capcut')}_${job.id}.mp4`);
    const dl = await api.downloadVideo(renderResult.video_url, outPath);

    const publicUrl = `/files/videos/${path.basename(outPath)}`;
    job.videoPath = dl.outPath;
    job.videoUrl = publicUrl;
    job.renderSource = 'capcut-direct-api';
    job.status = 'completed';
    job.progress = 100;
    job.message = 'Render completed via pure API (no browser editor)';
    job.updatedAt = Date.now();
    logger.info({ jobId: job.id, publicUrl, size: dl.size }, 'Direct render job completed');
  } catch (err) {
    logger.error({ jobId: job.id, err: err.message, stack: err.stack }, 'Direct render job failed');
    job.status = 'failed';
    job.error = err.message;
    job.updatedAt = Date.now();

    // Add hint for session expiry
    if (err.message.includes('1015') || err.message.includes('notLogin') || err.message.includes('SESSION_EXPIRED')) {
      job.error = err.message + ' → Refresh session at /login endpoint.';
    }
    throw err;
  }
}

// ====== Draft builder ======

/**
 * Load golden fixture from scripts/capture-oneshot.js output.
 * Expected file: tmp/captured-save-body.json (body of plane_draft/save).
 * We parse template_data if present, patch materials.videos video_id/asset refs.
 */
function loadCapturedSaveFixture(assets, { draftId }) {
  const candidates = [
    path.join(process.cwd(), 'tmp', 'captured-save-body.json'),
    path.join(process.cwd(), 'captured-save-body.json'),
  ];
  let raw = null;
  let source = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        source = p;
        break;
      } catch (_) {}
    }
  }
  if (!raw) return null;

  // Body shape variants:
  //  A) full save body: { package_key, template_data: "<json string>", materials, package_assets, ... }
  //  B) already-parsed draft content object with materials + tracks
  let content = null;
  let materials = null;
  let packageAssets = null;

  if (typeof raw.template_data === 'string') {
    try {
      content = JSON.parse(raw.template_data);
    } catch (_) {
      return null;
    }
    materials = raw.materials || content.materials || {};
    packageAssets = raw.package_assets || null;
  } else if (raw.materials || raw.tracks) {
    content = raw;
    materials = raw.materials || {};
  } else if (raw.template_data && typeof raw.template_data === 'object') {
    content = raw.template_data;
    materials = raw.materials || content.materials || {};
    packageAssets = raw.package_assets || null;
  } else {
    return null;
  }

  // Deep clone and patch video material IDs with newly uploaded assets
  content = JSON.parse(JSON.stringify(content));
  materials = JSON.parse(JSON.stringify(materials || content.materials || {}));
  const videos = materials.videos || content.materials?.videos || [];
  if (Array.isArray(videos) && assets.length) {
    for (let i = 0; i < Math.min(videos.length, assets.length); i++) {
      const a = assets[i];
      const id = a.cloud_asset_id || a.vid;
      videos[i] = {
        ...videos[i],
        video_id: id,
        material_id: id,
        md5: a.md5 || videos[i].md5,
        material_url: a.uri || videos[i].material_url,
        width: a.width || videos[i].width,
        height: a.height || videos[i].height,
      };
    }
    materials.videos = videos;
    if (content.materials) content.materials.videos = videos;
  }

  // Fresh package key for this job
  if (content.id) content.id = draftId;

  return {
    source,
    content,
    materials,
    packageAssets,
  };
}

function buildDraft(assets, { draftId, videoName }) {
  const durationUs = 5_000_000; // timeline 5s
  // CapCut desktop/web convention: still photo material duration ≈ 3 hours (µs)
  const PHOTO_MATERIAL_DURATION = 10_800_000_000;
  const materials = {
    videos: [],
    audios: [],
    texts: [],
    effects: [],
    stickers: [],
    filters: [],
    transitions: [],
    images: [],
    raw_materials: [],
    material_animations: [],
    material_colors: [],
    sound_channels: [],
    sound_channel_mappings: [],
    video_effects: [],
    montages: [],
    masks: [],
    multi_language_texts: [],
  };

  const segments = [];
  const segmentDuration = Math.floor(durationUs / assets.length);

  assets.forEach((asset, i) => {
    const materialId = `mat-${draftId}-${i}`;
    const segmentId = `seg-${draftId}-${i}`;
    const segStart = i * segmentDuration;

    // Build video material — use cloud_asset_id (preferred) or vid as material_id
    const matVideoId = asset.cloud_asset_id || asset.vid;
    materials.videos.push({
      id: materialId,
      type: 'photo',
      path: '',
      media_path: '',
      local_id: '',
      has_audio: false,
      reverse_path: '',
      intensifies_path: '',
      reverse_intensifies_path: '',
      intensifies_audio_path: '',
      cartoon_path: '',
      width: asset.width || 1080,
      height: asset.height || 1920,
      duration: PHOTO_MATERIAL_DURATION,
      category_id: '',
      category_name: '',
      material_id: matVideoId,
      material_name: path.basename(asset.uri || ''),
      material_url: asset.uri,
      crop_ratio: '1,1,0,0,0,0,0,0',
      crop_scale: { x: 1, y: 1 },
      extra_type_option: 0,
      source: 0,
      source_platform: 0,
      formula_id: '',
      check_flag: 0,
      is_unified_beauty_mode: false,
      picture_from: '',
      picture_set_category_id: '',
      picture_set_category_name: '',
      team_id: '',
      local_material_id: '',
      origin_material_id: '',
      request_id: '',
      has_sound_separated: false,
      is_text_edit_overdub: false,
      is_ai_generate_content: false,
      aigc_type: 0,
      is_copyright: false,
      aigc_history_id: '',
      aigc_item_id: '',
      local_material_from: '',
      beauty_body_preset_id: '',
      live_photo_cover_path: '',
      md5: asset.md5,
      name: path.basename(asset.uri || `asset-${i}`),
      music_id: '',
      text_id: '',
      tone_type: '',
      video_id: matVideoId,
      effect_id: '',
      resource_id: '',
      third_resource_id: '',
      tone_speaker: '',
      // Required nested objects (from Cm schema in bundle-035.js)
      crop: {
        lower_left_x: 0, lower_left_y: 0, upper_right_x: 1, upper_right_y: 1,
        ratio: { x: 1, y: 1 }, center: { x: 0.5, y: 0.5 }, normal: { x: 1, y: 1 },
      },
      stable: { stable_level: 0, matrix_path: '', time_range: { start: 0, duration: segmentDuration } },
      matting: {
        path: '', has_use_quick_brush: false, has_use_quick_eraser: false,
        interactiveTime: [], paths: [], flag: 0, interactiveMattingPath: '',
      },
      video_algorithm: { path: '', algorithms: [], gameplay_configs: [] },
    });

    segments.push({
      id: segmentId,
      desc: '',
      state: 1,
      speed: 1.0,
      is_loop: false,
      is_tone_modify: false,
      reverse: false,
      intensifies_audio: false,
      cartoon: false,
      volume: 1.0,
      last_nonzero_volume: 1.0,
      material_id: materialId,
      render_index: i,
      enable_lut: false,
      enable_adjust: false,
      enable_hsl: false,
      visible: true,
      group_id: '',
      enable_color_curves: false,
      track_render_index: i,
      enable_color_wheels: false,
      track_attribute: 0,
      is_placeholder: false,
      template_id: '',
      enable_smart_color_adjust: false,
      template_scene: '',
      enable_color_match_adjust: false,
      enable_color_correct_adjust: false,
      enable_adjust_mask: false,
      raw_segment_id: '',
      enable_video_mask: false,
      source_timerange: { start: 0, duration: segmentDuration },
      target_timerange: { start: segStart, duration: segmentDuration },
      render_timerange: { start: segStart, duration: segmentDuration },
      clip: {
        scale: { x: 1.0, y: 1.0 },
        transform: { x: 0, y: 0 },
        rotation: 0,
      },
      responsive_layout: {
        enable: false,
        target_follow: '',
        size_layout: '',
        horizontal_pos_layout: '',
        vertical_pos_layout: '',
      },
    });
  });

  return {
    id: draftId,
    type: 5,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    duration: durationUs,
    create_time: Date.now(),
    update_time: Date.now(),
    version: '1.0.0',
    fps: 30,
    ratio: '9:16',
    materials,
    tracks: [{
      id: `track-${draftId}`,
      type: 'video',
      segments,
    }],
  };
}

export default app;
