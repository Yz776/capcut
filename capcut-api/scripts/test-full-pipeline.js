// scripts/test-full-pipeline.js
//
// Full pure-API render pipeline:
//   1. Get ever_photo token (STS)
//   2. Upload user image (Mode A → Mode B → upload bytes → create_cloud_asset)
//   3. Save draft with the uploaded asset as material
//   4. Create render task
//   5. Poll until done
//   6. Download video

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';
const SPACE_ID = '7671928862355588103'; // from workspace info

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Full Pure-API Render Pipeline ===`);
  console.log(`Test image: ${TEST_IMAGE}\n`);

  if (!fs.existsSync(TEST_IMAGE)) {
    console.error(`✗ Test image not found: ${TEST_IMAGE}`);
    process.exit(1);
  }

  const fileBuf = fs.readFileSync(TEST_IMAGE);
  const fileSize = fileBuf.length;
  const fileName = path.basename(TEST_IMAGE);
  const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
  console.log(`File: ${fileName} size=${fileSize} md5=${md5}`);

  // === STEP 1: Get ever_photo token ===
  console.log('\n--- Step 1: Get ever_photo token ---');
  let everphotoToken = '';
  let everphotoUserId = '';
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/get_ever_photo_token',
      { workspace_id: api.workspaceId }
    );
    everphotoToken = res.data?.data?.token || '';
    everphotoUserId = res.data?.data?.ever_photo_user?.web_user_id || '';
    console.log(`✓ token len=${everphotoToken.length} user_id=${everphotoUserId}`);
  } catch (e) { console.log('✗', e.message); }

  // === STEP 2: Mode A — prepare_upload_cloud (STS init) ===
  console.log('\n--- Step 2: Mode A — prepare_upload_cloud (STS init) ---');
  let stsData = null;
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/asset/prepare_upload_cloud',
      {
        space_id: '0',
        workspace_id: api.workspaceId,
        is_web_user: true,
      }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      stsData = res.data.data;
      console.log('STS data keys:', Object.keys(stsData));
      console.log('STS data:', JSON.stringify(stsData, null, 2).slice(0, 1500));
      fs.writeFileSync('./tmp/sts-data.json', JSON.stringify(stsData, null, 2));
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 800));
  }

  // === STEP 3: Mode B — prepare_upload_cloud (per-file) ===
  console.log('\n--- Step 3: Mode B — prepare_upload_cloud (per-file) ---');
  let uploadId = '';
  let uploadUrl = '';
  let storeUri = '';
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/asset/prepare_upload_cloud',
      {
        workspace_id: api.workspaceId,
        space_id: '0',
        md5: md5,
        size: fileSize,
        file_type: 'image',
        flags: 0,
        is_web_user: true,
      }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Mode B data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
      uploadId = res.data.data.upload_id || '';
      uploadUrl = res.data.data.upload_url || '';
      storeUri = res.data.data.store_uri || res.data.data.uri || '';
      fs.writeFileSync('./tmp/upload-prepare.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 800));
  }

  // === STEP 4: Upload bytes to cloud storage ===
  console.log('\n--- Step 4: Upload file bytes ---');
  if (uploadUrl) {
    try {
      console.log(`PUT ${uploadUrl.slice(0, 80)}...`);
      const putRes = await axios.put(uploadUrl, fileBuf, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Content-Length': fileSize,
        },
        timeout: 60000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      console.log(`✓ PUT status=${putRes.status}`);
    } catch (e) {
      console.log('✗', e.message);
      if (e.response) console.log('  resp:', e.response.status, JSON.stringify(e.response.data).slice(0, 300));
    }
  } else {
    console.log('⚠ no upload_url — skipping PUT');
  }

  // === STEP 5: create_cloud_asset ===
  console.log('\n--- Step 5: create_cloud_asset ---');
  let assetId = '';
  let assetFileUrl = '';
  try {
    const assetBody = {
      everphoto_id: everphotoUserId,
      asset: {
        size: fileSize,
        workspace_id: api.workspaceId,
        filename: fileName,
        upload_id: uploadId,
        if_image_async_resize: true,
        space_id: '0',
        flags: 0,
        file_type: 'image',
        folder_id: '',
        meta: '{}',
        md5: md5,
        no_copy: false,
        ...(storeUri ? { uri: storeUri } : {}),
      },
      is_web_user: true,
    };
    console.log('Body:', JSON.stringify(assetBody, null, 2).slice(0, 1000));
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/asset/create_cloud_asset',
      assetBody
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Asset data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
      assetId = res.data.data.asset_id || res.data.data.id || '';
      assetFileUrl = res.data.data.file_url || res.data.data.url || '';
      fs.writeFileSync('./tmp/asset-created.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 800));
  }

  if (!assetId) {
    console.log('\n✗ No asset_id — cannot continue. Stopping.');
    return;
  }
  console.log(`\n✓ Asset uploaded: asset_id=${assetId}`);

  // === STEP 6: Save draft with the uploaded asset ===
  console.log('\n--- Step 6: Save draft with asset ---');
  const draftId = String(Date.now()) + Math.floor(Math.random() * 1000);

  // Build a minimal draft that references the uploaded asset
  const draftData = {
    id: draftId,
    type: 5,
    tracks: [{
      id: 'track1',
      type: 'image',
      segments: [{
        id: 'seg1',
        material_id: 'mat1',
        target_timerange: { start: 0, duration: 5000000 }, // 5 seconds in microseconds
        source_timerange: { start: 0, duration: 5000000 },
      }],
    }],
    materials: {
      images: [{
        material_id: 'mat1',
        asset_id: assetId,
        file_url: assetFileUrl,
        url: assetFileUrl,
        width: 1080,
        height: 1920,
        duration: 5000000,
        source_platform: 'capcut',
      }],
      videos: [],
      audios: [],
      texts: [],
      effects: [],
      stickers: [],
      filters: [],
      transitions: [],
    },
    duration: 5000000,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    version: '1.0.0',
  };

  const draftMeta = {
    draft: {
      id: draftId,
      name: 'Pure API Render',
      type: 5,
      duration: 0,
      updateTime: Date.now(),
      size: fileSize,
      segmentCount: 1,
      version: '1.0.0',
      platformSupport: 'browser',
      isMainTrackEmpty: false,
      isScriptTemplate: false,
      renderIndexTrackMode: false,
      canvasInfo: { width: 1080, height: 1920, sizeUnit: 'px', pageInfoList: [{ width: 1080, height: 1920, sizeUnit: 'px', unit: 'px' }] },
      coverUrl: 'cover.jpg',
      cover: 'cover.jpg',
      graphicInfo: { isUseInCn: false, isBatch: false },
    },
    uploadSource: { owner: api.userId, platform: 'browser', systemVersion: 'Mozilla/5.0', appVersion: '1.0.0', createTime: Date.now() },
    createSource: { owner: api.userId, platform: 'browser', systemVersion: 'Mozilla/5.0', appVersion: '1.0.0', createTime: Date.now() },
  };

  const saveBody = {
    workspace_id: api.workspaceId,
    package_type: 5,
    package_key: draftId,
    base_package_id: '0',
    template_data: JSON.stringify(draftData),
    template_meta: JSON.stringify(draftMeta),
    package_assets: [{
      source_path: fileName,
      md5: md5,
      size: fileSize,
    }],
    referenced_assets: [{
      source_path: fileName,
      md5: md5,
      size: fileSize,
    }],
    materials: draftData.materials,
    user_actions: '{}',
    cover_image_content: '',
    page_covers: [],
  };

  let savedPackageId = '';
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/save',
      saveBody
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1500));
    if (res.data?.data?.package_id) {
      savedPackageId = res.data.data.package_id;
      console.log(`✓ Draft saved! package_id=${savedPackageId}`);
      fs.writeFileSync('./tmp/draft-saved.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 800));
  }

  if (!savedPackageId) {
    console.log('\n✗ Draft save failed. Stopping.');
    return;
  }

  // === STEP 7: Verify draft via get_draft_detail ===
  console.log('\n--- Step 7: Verify draft via get_draft_detail ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/get_draft_detail',
      {
        package_key: savedPackageId,
        app_version: '5.8.0',
        sdk_version: '16.1.0',
        lang: 'en-US',
        region: 'ID',
        workspace_id: api.workspaceId,
        package_asset_limit: 30,
      }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Draft detail keys:', Object.keys(res.data.data));
      fs.writeFileSync('./tmp/draft-detail.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) { console.log('✗', e.message); }

  // === STEP 8: Create render task ===
  console.log('\n--- Step 8: Create render task ---');
  let taskId = null;
  try {
    const submitId = `${Date.now()}_${Math.random()}`;
    const body = {
      app_version: '1.0.0.285',
      sdk_version: '127.0.0',
      extra: '{}',
      type: 0,
      region: 'SG',
      app_id: 348188,
      width: 1080,
      height: 1920,
      fps: 30,
      format: 'mp4',
      cover: '',
      duration: 5000000,
      quality: 100,
      definition: '720p',
      task_id: '',
      video_name: 'Pure API Test',
      draft_id: savedPackageId,
      package_id: '',
      video_id: '',
      video_path: '',
      group_id: '',
      custom_info: '{}',
      from_workspace_id: api.workspaceId,
      to_workspace_id: api.workspaceId,
      force_export: false,
      submit_id: submitId,
    };
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/render_task/create',
      body
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1500));
    if (res.data?.data?.task_id && res.data.data.task_id !== '0') {
      taskId = res.data.data.task_id;
      console.log(`✓✓✓ RENDER TASK CREATED! task_id=${taskId}`);
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 800));
  }

  if (!taskId) {
    console.log('\n✗ Render task creation failed. Stopping.');
    return;
  }

  // === STEP 9: Poll render task ===
  console.log(`\n--- Step 9: Poll render task ${taskId} ---`);
  const startTime = Date.now();
  let pollCount = 0;
  while (Date.now() - startTime < 180000) { // 3 min
    pollCount++;
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/render_task/batch_get',
        { task_ids: [taskId] }
      );
      const taskInfo = res.data?.data?.tasks?.[0] || res.data?.data?.task_list?.[0] || res.data?.data?.render_task || res.data?.data;
      const status = taskInfo?.status ?? taskInfo?.state;
      const progress = taskInfo?.progress || 0;
      const videoUrl = taskInfo?.video_url || taskInfo?.video?.url || taskInfo?.download_url;
      console.log(`  poll #${pollCount}: status=${status} progress=${progress} hasUrl=${!!videoUrl}`);
      if (pollCount <= 3 || pollCount % 10 === 0) {
        console.log('    raw:', JSON.stringify(taskInfo, null, 2).slice(0, 800));
      }
      if (status === 2 || status === 'success' || status === 'done' || status === 'completed') {
        console.log(`\n✓✓✓ RENDER COMPLETED!`);
        if (videoUrl) {
          console.log(`video_url: ${videoUrl}`);
          fs.writeFileSync('./tmp/render-result.json', JSON.stringify(taskInfo, null, 2));
          // Download
          try {
            const dlRes = await api.downloadVideo(videoUrl, './tmp/rendered-video.mp4');
            console.log('✓✓✓✓✓ VIDEO DOWNLOADED:', dlRes);
          } catch (e) { console.log('✗ download failed:', e.message); }
        }
        break;
      }
      if (status === 3 || status === 'failed' || status === 'error') {
        console.log(`\n✗ RENDER FAILED`);
        console.log(JSON.stringify(taskInfo, null, 2));
        break;
      }
    } catch (e) {
      console.log(`  poll #${pollCount} error:`, e.message);
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
