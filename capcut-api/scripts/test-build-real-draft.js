// scripts/test-build-real-draft.js
//
// Build a proper CapCut draft JSON using the schema we reverse-engineered
// from bundle-035.js. Then save it and immediately trigger render.
//
// Key findings from bundle:
//   - Material base fields (Ne): id, type, name, path, category_name, source_platform, video_id, ...
//   - Video material schema: id, type, path, media_path, width, height, has_audio, material_id,
//     material_name, material_url, source, source_platform, picture_from, ...
//   - Video segment schema: id, desc, state, speed, is_loop, ..., material_id, render_index, visible, ...
//
// Run: node scripts/test-build-real-draft.js [image-path]

import fs from 'node:fs';
import path from 'node:path';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function main() {
  console.log(`\n=== Build Real Draft + Render ===`);
  console.log(`Test image: ${TEST_IMAGE}\n`);

  if (!fs.existsSync(TEST_IMAGE)) {
    console.error(`✗ Test image not found: ${TEST_IMAGE}`);
    process.exit(1);
  }
  const fileName = path.basename(TEST_IMAGE);

  const api = new CapCutDirectAPI();
  await api._init();
  console.log(`✓ Auth initialized. workspaceId=${api.workspaceId}`);

  // === STEP 1: Upload asset ===
  console.log('\n--- Step 1: Upload asset ---');
  const asset = await api.uploadAsset(TEST_IMAGE);
  console.log(`✓ Uploaded: vid=${asset.vid} uri=${asset.uri} w=${asset.width} h=${asset.height}`);

  // === STEP 2: Build draft JSON with proper structure ===
  console.log('\n--- Step 2: Build draft JSON ---');
  const draftId = String(Date.now()) + Math.floor(Math.random() * 1000);
  const materialId = 'mat-' + draftId;
  const trackId = 'track-' + draftId;
  const segmentId = 'seg-' + draftId;
  const durationUs = 5_000_000;  // 5 seconds

  // Try the FULL CapCut video material schema based on bundle-035.js
  const draftData = {
    id: draftId,
    type: 5,  // 5 = template draft
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
        type: 'photo',  // CapCut uses "photo" for image materials in videos[]
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
        duration: durationUs,
        category_id: '',
        category_name: '',
        material_id: asset.vid,
        material_name: fileName,
        material_url: asset.uri,
        crop_ratio: '1,1,0,0,0,0,0,0',
        crop_scale: { x: 1, y: 1 },
        extra_type_option: 0,
        source: 0,  // 0 = local
        source_platform: 0,  // 0 = local
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
        // Common material fields
        name: fileName,
        music_id: '',
        text_id: '',
        tone_type: '',
        video_id: asset.vid,
        effect_id: '',
        resource_id: '',
        third_resource_id: '',
        intensifies_audio_path: '',
        tone_speaker: '',
      }],
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
    },
    tracks: [{
      id: trackId,
      type: 'video',  // main video track
      segments: [{
        id: segmentId,
        desc: '',
        state: 1,  // 1 = active
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
        source_timerange: { start: 0, duration: durationUs },
        target_timerange: { start: 0, duration: durationUs },
        clip: {
          scale: { x: 1.0, y: 1.0 },
          transform: { x: 0, y: 0 },
          rotation: 0,
        },
      }],
    }],
  };

  console.log(`Draft ID: ${draftId}`);
  console.log(`Material ID: ${materialId}`);
  console.log(`Track ID: ${trackId}`);
  console.log(`Segment ID: ${segmentId}`);

  // Save draft JSON for inspection
  fs.writeFileSync('./tmp/draft-built.json', JSON.stringify(draftData, null, 2));
  console.log('Saved draft to tmp/draft-built.json');

  // === STEP 3: Save draft via API ===
  console.log('\n--- Step 3: Save draft ---');
  const packageAssets = [{
    source_path: fileName,
    md5: asset.md5,
    size: asset.fileSize,
  }];
  let saveResult;
  try {
    saveResult = await api.saveDraft(draftData, {
      packageKey: draftId,
      videoName: 'Real Draft Render Test',
      materials: draftData.materials,
      packageAssets,
    });
    console.log(`✓✓✓ DRAFT SAVED!`);
    console.log(`  package_key: ${saveResult.package_key}`);
    console.log(`  package_id:  ${saveResult.package_id}`);
  } catch (e) {
    console.log(`✗ Save failed: ${e.message}`);
    if (e.response?.data) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 2000));
    return;
  }
  fs.writeFileSync('./tmp/real-draft-saved.json', JSON.stringify(saveResult, null, 2));

  // === STEP 4: Get draft detail to verify it saved correctly ===
  console.log('\n--- Step 4: Verify draft via get_draft_detail ---');
  try {
    const detail = await api.getDraftDetail(saveResult.package_key);
    console.log(`✓ Draft detail retrieved`);
    console.log('  template_data length:', detail?.template_data?.length || 0);
    if (detail?.template_data) {
      try {
        const td = JSON.parse(detail.template_data);
        console.log('  parsed template_data keys:', Object.keys(td));
        console.log('  tracks count:', td.tracks?.length);
        console.log('  materials.videos count:', td.materials?.videos?.length);
        if (td.materials?.videos?.[0]) {
          console.log('  first video material keys:', Object.keys(td.materials.videos[0]).slice(0, 15));
        }
        fs.writeFileSync('./tmp/real-draft-detail-parsed.json', JSON.stringify(td, null, 2));
      } catch (e) {
        console.log('  ! could not parse template_data:', e.message);
      }
    }
  } catch (e) {
    console.log(`✗ get_draft_detail failed: ${e.message}`);
  }

  // === STEP 5: Create render task ===
  console.log('\n--- Step 5: Create render task ---');
  const renderTask = await api.createRenderTask({
    draftId: saveResult.package_key,
    packageId: saveResult.package_id,
    videoName: 'Real Draft Render Test',
    definition: '720p',
    width: 1080,
    height: 1920,
    fps: 30,
    duration: durationUs,
  });
  console.log(`✓✓✓ RENDER TASK CREATED! task_id: ${renderTask.task_id}`);
  fs.writeFileSync('./tmp/real-draft-task.json', JSON.stringify(renderTask, null, 2));

  // === STEP 6: Poll render task ===
  console.log('\n--- Step 6: Poll render task ---');
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

    // === STEP 7: Download video ===
    console.log('\n--- Step 7: Download video ---');
    const outPath = './tmp/real-rendered.mp4';
    const dl = await api.downloadVideo(renderResult.video_url, outPath);
    console.log(`✓✓✓✓✓✓ VIDEO DOWNLOADED!`);
    console.log(`  outPath: ${dl.outPath}`);
    console.log(`  size:    ${dl.size} bytes (${(dl.size / 1024 / 1024).toFixed(2)} MB)`);

    console.log('\n=== ✓✓✓✓✓✓ PURE-API RENDER PIPELINE COMPLETE WITH REAL DRAFT ===');
    console.log('NO BROWSER WAS NEEDED FOR THE RENDER STEP!');
  } catch (e) {
    console.log(`\n✗ Render failed: ${e.message}`);
    if (e.taskInfo) console.log('  taskInfo:', JSON.stringify(e.taskInfo, null, 2).slice(0, 1500));
  }
}

main().catch(e => {
  console.error('\n✗ Pipeline failed:', e.message);
  if (e.response) console.error('  resp:', JSON.stringify(e.response.data).slice(0, 1000));
  if (e.taskInfo) console.error('  taskInfo:', JSON.stringify(e.taskInfo).slice(0, 500));
  process.exit(1);
});
