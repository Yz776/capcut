// scripts/test-material-bisect.js
//
// Bisect what field in materials.videos[0] triggers ERR_DRAFT_NOT_COMPLETE.
// Start with empty {} and add fields one by one.

import fs from 'node:fs';
import path from 'node:path';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function trySave(api, label, draftContent, packageAssets = []) {
  const draftId = String(Date.now()) + Math.floor(Math.random() * 1000) + '_' + label.replace(/[^a-zA-Z0-9]/g, '');
  draftContent.id = draftId;

  const meta = {
    draft: {
      id: draftId, name: 'Bisect', type: 5,
      duration: draftContent.duration || 0,
      updateTime: Date.now(), size: 0,
      segmentCount: (draftContent.tracks?.[0]?.segments?.length) || 0,
      version: '1.0.0', platformSupport: 'browser',
      isMainTrackEmpty: !(draftContent.tracks?.length),
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
    package_assets: packageAssets,
    referenced_assets: packageAssets,
    materials: {},
    user_actions: '{}',
    cover_image_content: '',
    page_covers: [],
  };

  process.stdout.write(`  [${label}] `);
  try {
    const res = await api._axios.post('https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/save', body);
    const ret = res.data?.ret;
    if (ret === '0' || ret === 0) {
      console.log(`✓ SUCCESS package_id=${res.data?.data?.package_id}`);
      return { ok: true, packageId: res.data?.data?.package_id, draftId };
    } else {
      console.log(`✗ ret=${ret} errmsg=${res.data?.errmsg}`);
      return { ok: false, ret, errmsg: res.data?.errmsg };
    }
  } catch (e) {
    console.log(`✗ err ${e.message.slice(0, 60)}`);
    return { ok: false, err: e.message };
  }
}

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();
  console.log('Uploading asset...');
  const asset = await api.uploadAsset(TEST_IMAGE);
  console.log(`✓ vid=${asset.vid}\n`);
  const fileName = path.basename(TEST_IMAGE);
  const durationUs = 5_000_000;
  const pkgAssets = [{ source_path: fileName, md5: asset.md5, size: asset.fileSize }];

  const baseTrack = (matId) => ({
    id: 't1', type: 'video', segments: [{
      id: 's1', material_id: matId,
      source_timerange: { start: 0, duration: durationUs },
      target_timerange: { start: 0, duration: durationUs },
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 },
    }],
  });

  const makeDraft = (videoMaterial) => ({
    type: 5,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    duration: durationUs,
    version: '1.0.0',
    pages: [],
    materials: {
      videos: [videoMaterial],
      audios: [], texts: [], effects: [], stickers: [], filters: [],
      transitions: [], images: [], raw_materials: [],
    },
    tracks: [baseTrack(videoMaterial.id || 'mat1')],
  });

  const results = [];

  // M1: Empty material object
  results.push({ label: 'M1-empty-{}', ...(await trySave(api, 'M1', makeDraft({ id: 'mat1' }), pkgAssets)) });

  // M2: + type + path
  results.push({ label: 'M2-type-path', ...(await trySave(api, 'M2', makeDraft({
    id: 'mat1', type: 'photo', path: '',
  }), pkgAssets)) });

  // M3: M2 + material_id
  results.push({ label: 'M3-material_id', ...(await trySave(api, 'M3', makeDraft({
    id: 'mat1', type: 'photo', path: '',
    material_id: asset.vid,
  }), pkgAssets)) });

  // M4: M3 + material_url
  results.push({ label: 'M4-material_url', ...(await trySave(api, 'M4', makeDraft({
    id: 'mat1', type: 'photo', path: '',
    material_id: asset.vid, material_url: asset.uri,
  }), pkgAssets)) });

  // M5: M4 + width/height/duration
  results.push({ label: 'M5-dims', ...(await trySave(api, 'M5', makeDraft({
    id: 'mat1', type: 'photo', path: '',
    material_id: asset.vid, material_url: asset.uri,
    width: asset.width, height: asset.height, duration: durationUs,
  }), pkgAssets)) });

  // M6: M5 + source + source_platform
  results.push({ label: 'M6-source', ...(await trySave(api, 'M6', makeDraft({
    id: 'mat1', type: 'photo', path: '',
    material_id: asset.vid, material_url: asset.uri,
    width: asset.width, height: asset.height, duration: durationUs,
    source: 0, source_platform: 0,
  }), pkgAssets)) });

  // M7: M6 + name + material_name + md5
  results.push({ label: 'M7-name-md5', ...(await trySave(api, 'M7', makeDraft({
    id: 'mat1', type: 'photo', path: '',
    material_id: asset.vid, material_url: asset.uri,
    width: asset.width, height: asset.height, duration: durationUs,
    source: 0, source_platform: 0,
    name: fileName, material_name: fileName, md5: asset.md5,
  }), pkgAssets)) });

  // M8: M7 + has_audio + media_path + local_id
  results.push({ label: 'M8-has_audio', ...(await trySave(api, 'M8', makeDraft({
    id: 'mat1', type: 'photo', path: '',
    material_id: asset.vid, material_url: asset.uri,
    width: asset.width, height: asset.height, duration: durationUs,
    source: 0, source_platform: 0,
    name: fileName, material_name: fileName, md5: asset.md5,
    has_audio: false, media_path: '', local_id: '',
  }), pkgAssets)) });

  // M9: M8 + video_id (instead of material_id - maybe wrong field)
  results.push({ label: 'M9-video_id-only', ...(await trySave(api, 'M9', makeDraft({
    id: 'mat1', type: 'photo', path: '',
    video_id: asset.vid,  // only video_id, no material_id
    material_url: asset.uri,
    width: asset.width, height: asset.height, duration: durationUs,
    source: 0, source_platform: 0,
    name: fileName, material_name: fileName, md5: asset.md5,
    has_audio: false,
  }), pkgAssets)) });

  // M10: minimal but with all the "common material" required fields
  results.push({ label: 'M10-all-common', ...(await trySave(api, 'M10', makeDraft({
    id: 'mat1', type: 'photo', name: fileName, path: '',
    category_name: '', music_id: '', text_id: '', tone_type: '',
    source_platform: 0, video_id: asset.vid, effect_id: '',
    resource_id: '', third_resource_id: '', category_id: '',
    intensifies_path: '', formula_id: '', check_flag: 0,
    team_id: '', local_material_id: '', request_id: '',
    material_id: asset.vid, material_name: fileName, material_url: asset.uri,
    width: asset.width, height: asset.height, duration: durationUs,
    source: 0, has_audio: false, media_path: '', local_id: '',
    md5: asset.md5,
  }), pkgAssets)) });

  // M11: Try type="video" with has_audio=true
  results.push({ label: 'M11-type-video', ...(await trySave(api, 'M11', makeDraft({
    id: 'mat1', type: 'video', name: fileName, path: '',
    material_id: asset.vid, material_name: fileName, material_url: asset.uri,
    width: asset.width, height: asset.height, duration: durationUs,
    source: 0, source_platform: 0, has_audio: true,
    md5: asset.md5, video_id: asset.vid,
  }), pkgAssets)) });

  // M12: Try type=0 (numeric) instead of "photo"
  results.push({ label: 'M12-type-0', ...(await trySave(api, 'M12', makeDraft({
    id: 'mat1', type: 0, name: fileName, path: '',
    material_id: asset.vid, material_name: fileName, material_url: asset.uri,
    width: asset.width, height: asset.height, duration: durationUs,
    source: 0, source_platform: 0, has_audio: false,
    md5: asset.md5, video_id: asset.vid,
  }), pkgAssets)) });

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`);
  }

  // Save the first successful material configuration
  const successes = results.filter(r => r.ok);
  if (successes.length > 0) {
    const first = successes[0];
    console.log(`\n=== First SUCCESS: ${first.label} ===`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
