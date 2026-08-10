// scripts/test-render-with-populated-template-data.js
//
// Hypothesis: body.materials = {} (empty) skips server-side validation.
// We can put ANY draft content in template_data, and as long as body.materials = {},
// the save will succeed. Then the render task uses the template_data.
//
// Pipeline:
//   1. Upload asset via pure-API VOD pipeline
//   2. Save draft with body.materials = {} but template_data has populated materials.videos[0] + tracks
//   3. Create render task
//   4. Poll render task until done
//   5. Download video

import fs from 'node:fs';
import path from 'node:path';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function main() {
  console.log(`\n=== Render with Populated Template Data ===`);
  console.log(`Test image: ${TEST_IMAGE}\n`);

  const api = new CapCutDirectAPI();
  await api._init();
  console.log(`✓ workspaceId=${api.workspaceId}`);

  // === STEP 1: Upload asset ===
  console.log('\n--- Step 1: Upload asset ---');
  const asset = await api.uploadAsset(TEST_IMAGE);
  console.log(`✓ Uploaded: vid=${asset.vid} w=${asset.width} h=${asset.height}`);
  const fileName = path.basename(TEST_IMAGE);

  // === STEP 2: Build draft with populated template_data ===
  console.log('\n--- Step 2: Build draft ---');
  const draftId = String(Date.now()) + Math.floor(Math.random() * 1000);
  const materialId = 'mat-' + draftId;
  const trackId = 'track-' + draftId;
  const segmentId = 'seg-' + draftId;
  const durationUs = 5_000_000;

  const draftContent = {
    id: draftId,
    type: 5,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    duration: durationUs,
    create_time: Date.now(),
    update_time: Date.now(),
    version: '1.0.0',
    fps: 30,
    ratio: '9:16',
    materials: {
      videos: [{
        id: materialId,
        type: 'photo',
        path: '',
        material_id: asset.vid,
        material_name: fileName,
        material_url: asset.uri,
        video_id: asset.vid,
        md5: asset.md5,
        width: asset.width || 1080,
        height: asset.height || 1920,
        duration: durationUs,
        source: 0,
        source_platform: 0,
        has_audio: false,
        name: fileName,
      }],
      audios: [],
      texts: [],
      effects: [],
      stickers: [],
      filters: [],
      transitions: [],
      images: [],
      raw_materials: [],
    },
    tracks: [{
      id: trackId,
      type: 'video',
      segments: [{
        id: segmentId,
        material_id: materialId,
        source_timerange: { start: 0, duration: durationUs },
        target_timerange: { start: 0, duration: durationUs },
        speed: 1.0,
        clip: { scale: { x: 1.0, y: 1.0 }, transform: { x: 0, y: 0 }, rotation: 0 },
      }],
    }],
  };

  // === STEP 3: Save draft with body.materials = {} (skip validation) ===
  console.log('\n--- Step 3: Save draft (body.materials={}) ---');

  // Build the save body manually, NOT using api.saveDraft (which sets body.materials = draftContent.materials)
  const meta = {
    draft: {
      id: draftId,
      name: 'Pure-API Render',
      type: 5,
      duration: durationUs,
      updateTime: Date.now(),
      size: 0,
      segmentCount: 1,
      version: '1.0.0',
      platformSupport: 'browser',
      isMainTrackEmpty: false,
      isScriptTemplate: false,
      renderIndexTrackMode: false,
      canvasInfo: {
        width: 1080, height: 1920, sizeUnit: 'px',
        pageInfoList: [{ width: 1080, height: 1920, sizeUnit: 'px', unit: 'px' }],
      },
      coverUrl: 'cover.jpg',
      cover: 'cover.jpg',
      graphicInfo: { isUseInCn: false, isBatch: false },
    },
    uploadSource: { owner: api.userId, platform: 'browser', systemVersion: 'Mozilla/5.0', appVersion: '1.0.0', createTime: Date.now() },
    createSource: { owner: api.userId, platform: 'browser', systemVersion: 'Mozilla/5.0', appVersion: '1.0.0', createTime: Date.now() },
  };

  const packageAssets = [{
    source_path: fileName,
    md5: asset.md5,
    size: asset.fileSize,
  }];

  const saveBody = {
    workspace_id: api.workspaceId,
    package_type: 5,
    package_key: draftId,
    base_package_id: '0',
    template_data: JSON.stringify(draftContent),
    template_meta: JSON.stringify(meta),
    package_assets: packageAssets,
    referenced_assets: packageAssets,
    materials: {},  // ← KEY: empty object to skip server-side material validation
    user_actions: '{}',
    cover_image_content: '',
    page_covers: [],
  };

  let packageId;
  try {
    const res = await api._axios.post('https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/save', saveBody);
    console.log(`✓ ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
    console.log(`  package_id: ${res.data?.data?.package_id}`);
    packageId = res.data?.data?.package_id;
    if (res.data?.ret !== '0' && res.data?.ret !== 0) {
      throw new Error(`Save failed: ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
    }
  } catch (e) {
    console.log(`✗ Save failed: ${e.message}`);
    if (e.response?.data) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 1500));
    return;
  }

  // === STEP 4: Verify draft was saved correctly ===
  console.log('\n--- Step 4: Verify draft via get_draft_detail ---');
  try {
    const res = await api._axios.post('https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/get_draft_detail', {
      package_key: draftId,
      app_version: '5.8.0',
      sdk_version: '16.1.0',
      lang: 'en-US',
      region: 'ID',
      workspace_id: api.workspaceId,
      package_asset_limit: 30,
    });
    console.log(`✓ ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
    if (res.data?.data?.template_data) {
      const td = JSON.parse(res.data.data.template_data);
      console.log(`  template_data tracks count: ${td.tracks?.length}`);
      console.log(`  template_data materials.videos count: ${td.materials?.videos?.length}`);
      if (td.materials?.videos?.[0]) {
        console.log(`  first video material id: ${td.materials.videos[0].id}`);
        console.log(`  first video material_id: ${td.materials.videos[0].material_id}`);
      }
      fs.writeFileSync('./tmp/saved-draft-content.json', JSON.stringify(td, null, 2));
      console.log('  Saved to tmp/saved-draft-content.json');
    }
  } catch (e) {
    console.log(`✗ get_draft_detail failed: ${e.message}`);
  }

  // === STEP 5: Create render task ===
  console.log('\n--- Step 5: Create render task ---');
  const renderTask = await api.createRenderTask({
    draftId: draftId,
    packageId: packageId,
    videoName: 'Pure-API Render',
    definition: '720p',
    width: 1080,
    height: 1920,
    fps: 30,
    duration: durationUs,
  });
  console.log(`✓✓✓ RENDER TASK CREATED! task_id: ${renderTask.task_id}`);
  fs.writeFileSync('./tmp/render-task.json', JSON.stringify(renderTask, null, 2));

  // === STEP 6: Poll render task ===
  console.log('\n--- Step 6: Poll render task ---');
  try {
    const renderResult = await api.pollRenderTask(renderTask.task_id, {
      intervalMs: 5000,
      timeoutMs: 240_000,
      onProgress: ({ status, progress, videoUrl }) => {
        console.log(`  status=${status} progress=${progress}%${videoUrl ? ' hasUrl' : ''}`);
      },
    });
    console.log(`\n✓✓✓✓✓ RENDER COMPLETED!`);
    console.log(`  video_url: ${renderResult.video_url}`);
    fs.writeFileSync('./tmp/render-result.json', JSON.stringify(renderResult, null, 2));

    // === STEP 7: Download video ===
    console.log('\n--- Step 7: Download video ---');
    const outPath = './tmp/rendered-video.mp4';
    const dl = await api.downloadVideo(renderResult.video_url, outPath);
    console.log(`✓✓✓✓✓✓ VIDEO DOWNLOADED!`);
    console.log(`  outPath: ${dl.outPath}`);
    console.log(`  size:    ${dl.size} bytes (${(dl.size / 1024 / 1024).toFixed(2)} MB)`);

    console.log('\n=== ✓✓✓✓✓✓✓✓ PURE-API RENDER PIPELINE COMPLETE ===');
    console.log('A real CapCut video was rendered and downloaded WITHOUT any browser editor!');
  } catch (e) {
    console.log(`\n✗ Render failed: ${e.message}`);
    if (e.taskInfo) console.log('  taskInfo:', JSON.stringify(e.taskInfo, null, 2).slice(0, 2000));
  }
}

main().catch(e => {
  console.error('\n✗ Pipeline failed:', e.message);
  if (e.response) console.error('  resp:', JSON.stringify(e.response.data).slice(0, 1000));
  if (e.taskInfo) console.error('  taskInfo:', JSON.stringify(e.taskInfo).slice(0, 500));
  process.exit(1);
});
