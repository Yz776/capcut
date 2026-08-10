// scripts/test-proper-draft-schema.js
//
// Build draft with PROPER schemas based on bundle-035.js class definitions:
//   - crop (In class, Ii schema): 8 snake_case fields (upper_left_x, ...)
//   - clip (TU class, TW schema): rotation, alpha, scale, transform, flip
//   - transform (cW class): x, y
//   - flip (f7 class): vertical, horizontal
//   - timerange (m7 class, m5 schema): start, duration as BigInt (strings in JSON)
//   - segment (SN/SD/kZ): with all common fields + target_timerange (required) + clip (nullable)
//
// Run: node scripts/test-proper-draft-schema.js

import fs from 'node:fs';
import path from 'node:path';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();
  console.log('Uploading asset...');
  const asset = await api.uploadAsset(TEST_IMAGE);
  console.log(`✓ vid=${asset.vid}\n`);
  const fileName = path.basename(TEST_IMAGE);
  const durationUs = 5_000_000;
  const pkgAssets = [{ source_path: fileName, md5: asset.md5, size: asset.fileSize }];

  const draftId = String(Date.now()) + Math.floor(Math.random() * 1000);
  const materialId = 'mat-' + draftId;

  // Build a video material with PROPER schemas
  const videoMaterial = {
    // === Common fields from Cm schema (all required) ===
    id: materialId,
    type: 'photo',  // CapCut uses 'photo' for image materials in videos[]
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
    category_id: '',
    category_name: '',
    material_id: asset.vid,
    material_name: fileName,
    material_url: asset.uri,
    crop_ratio: '',
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
    // === bigint fields ===
    duration: String(durationUs),  // BigInt as string
    live_photo_timestamp: '0',
    // === object fields (required, non-nullable) ===
    crop: {
      // In class / Ii schema — snake_case fields with defaults
      upper_left_x: 0,
      upper_left_y: 0,
      upper_right_x: 1,
      upper_right_y: 0,
      lower_left_x: 0,
      lower_left_y: 1,
      lower_right_x: 1,
      lower_right_y: 1,
    },
    // stable (I_ class, Im schema) — REQUIRED
    stable: {
      stable_level: 0,
      matrix_path: '',
      time_range: { start: '0', duration: '0' },
    },
    // matting (IC class, IA schema) — REQUIRED
    matting: {
      path: '',
      has_use_quick_brush: false,
      has_use_quick_eraser: false,
      reverse: false,
      custom_matting_id: '',
      blendMode: 0,
      blendColor: '',
      flag: '0',
      expansion: '0',
      feather: '0',
      interactiveTime: [],
      strokes: [],
    },
    // video_algorithm (EA class, Ek schema) — REQUIRED
    video_algorithm: {
      path: '',
      algorithms: [],
      gameplay_configs: [],
      ai_background_configs: [],
    },
    // === Extra fields from base material schema (Ne) ===
    name: fileName,
    md5: asset.md5,
    video_id: asset.vid,
    music_id: '',
    text_id: '',
    tone_type: '',
    effect_id: '',
    resource_id: '',
    third_resource_id: '',
    intensifies_audio_path: '',
    tone_speaker: '',
  };

  const draftContent = {
    id: draftId,
    type: 5,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    duration: String(durationUs),  // BigInt as string
    create_time: Date.now(),
    update_time: Date.now(),
    version: '1.0.0',
    fps: 30,
    ratio: '9:16',
    pages: [],
    materials: {
      videos: [videoMaterial],
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
      id: 'track-' + draftId,
      type: 'video',
      segments: [{
        // === Segment common fields from SN/kZ schema ===
        id: 'seg-' + draftId,
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
        render_index: 0,
        enable_lut: false,
        enable_adjust: false,
        enable_hsl: false,
        visible: true,
        group_id: '',
        enable_color_curves: false,
        track_render_index: 0,
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
        // === bigint fields ===
        offset: '0',
        // === object fields ===
        // source_timerange is nullable, target_timerange is REQUIRED, render_timerange is REQUIRED
        source_timerange: { start: '0', duration: String(durationUs) },  // m7 with string BigInts
        target_timerange: { start: '0', duration: String(durationUs) },  // m7 (required)
        render_timerange: { start: '0', duration: String(durationUs) },  // m7 (required - was missing!)
        // responsive_layout is REQUIRED (not nullable) - Sb class with Sk schema
        responsive_layout: {
          enable: false,
          target_follow: '',
          size_layout: 0,
          horizontal_pos_layout: 0,
          vertical_pos_layout: 0,
        },
        // clip is nullable, but include it anyway with proper TU/TW structure
        clip: {
          // TW schema: common [rotation, alpha], object {scale, transform, flip}
          rotation: 0,
          alpha: 1,
          scale: { x: 1, y: 1 },  // cO class — likely has x, y
          transform: { x: 0, y: 0 },  // cW class with x, y
          flip: { vertical: false, horizontal: false },  // f7 class
        },
      }],
    }],
  };

  const meta = {
    draft: {
      id: draftId, name: 'Proper Schema Test', type: 5,
      duration: durationUs,
      updateTime: Date.now(), size: 0,
      segmentCount: 1,
      version: '1.0.0', platformSupport: 'browser',
      isMainTrackEmpty: false,
      isScriptTemplate: false, renderIndexTrackMode: false,
      canvasInfo: { width: 1080, height: 1920, sizeUnit: 'px', pageInfoList: [{ width: 1080, height: 1920, sizeUnit: 'px', unit: 'px' }] },
      coverUrl: 'cover.jpg', cover: 'cover.jpg', graphicInfo: { isUseInCn: false, isBatch: false },
    },
    uploadSource: { owner: api.userId, platform: 'browser', systemVersion: 'Mozilla/5.0', appVersion: '1.0.0', createTime: Date.now() },
    createSource: { owner: api.userId, platform: 'browser', systemVersion: 'Mozilla/5.0', appVersion: '1.0.0', createTime: Date.now() },
  };

  const body = {
    workspace_id: api.workspaceId,
    package_type: 5,
    package_key: draftId,
    base_package_id: '0',
    template_data: JSON.stringify(draftContent),
    template_meta: JSON.stringify(meta),
    package_assets: pkgAssets,
    referenced_assets: pkgAssets,
    materials: {},
    user_actions: '{}',
    cover_image_content: '',
    page_covers: [],
  };

  console.log('Saving draft with proper schemas...');
  console.log('video material:', JSON.stringify(videoMaterial, null, 2).slice(0, 500));
  console.log('segment:', JSON.stringify(draftContent.tracks[0].segments[0], null, 2).slice(0, 800));

  try {
    const res = await api._axios.post('https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/save', body);
    console.log(`\n✓ ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
    if (res.data?.ret === '0' || res.data?.ret === 0) {
      console.log(`✓✓✓ SUCCESS! package_id=${res.data?.data?.package_id}`);
      console.log(`  draft_id (package_key): ${draftId}`);
      fs.writeFileSync('./tmp/proper-schema-draft.json', JSON.stringify({
        draftId,
        packageId: res.data?.data?.package_id,
        draftContent,
      }, null, 2));
      console.log('Saved to tmp/proper-schema-draft.json');

      // Verify draft was saved correctly
      console.log('\nVerifying draft via get_draft_detail...');
      const detailRes = await api._axios.post('https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/get_draft_detail', {
        package_key: draftId,
        app_version: '5.8.0',
        sdk_version: '16.1.0',
        lang: 'en-US',
        region: 'ID',
        workspace_id: api.workspaceId,
        package_asset_limit: 30,
      });
      console.log(`  ret=${detailRes.data?.ret} errmsg=${detailRes.data?.errmsg}`);
      if (detailRes.data?.data?.template_data) {
        const td = JSON.parse(detailRes.data.data.template_data);
        console.log(`  tracks count: ${td.tracks?.length}`);
        console.log(`  materials.videos count: ${td.materials?.videos?.length}`);
        if (td.materials?.videos?.[0]) {
          console.log(`  video material keys:`, Object.keys(td.materials.videos[0]).slice(0, 20));
          console.log(`  video material.material_id: ${td.materials.videos[0].material_id}`);
          console.log(`  video material.crop:`, JSON.stringify(td.materials.videos[0].crop));
        }
      }

      // === Try to render! ===
      console.log('\n=== Creating render task ===');
      const renderTask = await api.createRenderTask({
        draftId: draftId,
        packageId: res.data?.data?.package_id,
        videoName: 'Proper Schema Render',
        definition: '720p',
        width: 1080,
        height: 1920,
        fps: 30,
        duration: durationUs,
      });
      console.log(`✓ RENDER TASK CREATED! task_id: ${renderTask.task_id}`);

      console.log('\n=== Polling render task ===');
      try {
        const renderResult = await api.pollRenderTask(renderTask.task_id, {
          intervalMs: 5000,
          timeoutMs: 180_000,
          onProgress: ({ status, progress, videoUrl }) => {
            console.log(`  status=${status} progress=${progress}%${videoUrl ? ' hasUrl' : ''}`);
          },
        });
        console.log(`\n✓✓✓✓✓ RENDER COMPLETED!`);
        console.log(`  video_url: ${renderResult.video_url}`);
        // Download
        const outPath = './tmp/proper-schema-rendered.mp4';
        const dl = await api.downloadVideo(renderResult.video_url, outPath);
        console.log(`✓✓✓✓✓✓ VIDEO DOWNLOADED! size=${dl.size} bytes (${(dl.size/1024/1024).toFixed(2)} MB)`);
        console.log(`  outPath: ${dl.outPath}`);
      } catch (e) {
        console.log(`\n✗ Render failed: ${e.message}`);
        if (e.taskInfo) console.log('  taskInfo:', JSON.stringify(e.taskInfo, null, 2).slice(0, 1500));
      }
    } else {
      console.log('Full response:', JSON.stringify(res.data, null, 2).slice(0, 1000));
    }
  } catch (e) {
    console.log(`✗ Save failed: ${e.message}`);
    if (e.response?.data) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 1500));
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
