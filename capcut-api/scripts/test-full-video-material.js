// scripts/test-full-video-material.js
//
// Build a video material with ALL fields from the Cm schema (bundle-035.js offset 1547525):
//   common: [id, type, path, media_path, local_id, has_audio, reverse_path, intensifies_path,
//            reverse_intensifies_path, intensifies_audio_path, cartoon_path, width, height,
//            category_id, category_name, material_id, material_name, material_url,
//            crop_ratio, crop_scale, extra_type_option, source, source_platform, formula_id,
//            check_flag, is_unified_beauty_mode, picture_from, picture_set_category_id,
//            picture_set_category_name, team_id, local_material_id, origin_material_id,
//            request_id, has_sound_separated, is_text_edit_overdub, is_ai_generate_content,
//            aigc_type, is_copyright, aigc_history_id, aigc_item_id, local_material_from,
//            beauty_body_preset_id, live_photo_cover_path]
//   bigint: {duration, live_photo_timestamp}
//   object: {crop, audio_fade, stable, matting, video_algorithm, ...}
//
// Run: node scripts/test-full-video-material.js

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

  // Build a video material with ALL common fields from Cm schema
  const videoMaterial = {
    // common fields
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
    // bigint fields
    duration: durationUs,
    live_photo_timestamp: 0,
    // object fields — only include the required (non-nullable) ones
    crop: {
      // The crop class In — try with sensible defaults
      lower: { x: 0, y: 0 },
      upper: { x: 1, y: 1 },
      transform: { x: 0, y: 0 },
    },
    // name from base schema
    name: fileName,
    // md5 (from our upload)
    md5: asset.md5,
    // video_id from base schema
    video_id: asset.vid,
  };

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
        id: 'seg-' + draftId,
        material_id: materialId,
        source_timerange: { start: 0, duration: durationUs },
        target_timerange: { start: 0, duration: durationUs },
        speed: 1.0,
        clip: { scale: { x: 1.0, y: 1.0 }, transform: { x: 0, y: 0 }, rotation: 0 },
      }],
    }],
  };

  const meta = {
    draft: {
      id: draftId, name: 'Full Material Test', type: 5,
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

  console.log('Saving draft with full video material...');
  try {
    const res = await api._axios.post('https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/save', body);
    console.log(`✓ ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
    if (res.data?.ret === '0' || res.data?.ret === 0) {
      console.log(`✓✓✓ SUCCESS! package_id=${res.data?.data?.package_id}`);
      console.log(`  draft_id (package_key): ${draftId}`);
      fs.writeFileSync('./tmp/full-material-draft.json', JSON.stringify({
        draftId,
        packageId: res.data?.data?.package_id,
        draftContent,
      }, null, 2));
      console.log('Saved to tmp/full-material-draft.json');
    } else {
      console.log('Full response:', JSON.stringify(res.data, null, 2).slice(0, 1000));
    }
  } catch (e) {
    console.log(`✗ Save failed: ${e.message}`);
    if (e.response?.data) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 1500));
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
