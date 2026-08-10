// scripts/test-draft-bisect.js
//
// Bisect what triggers ERR_DRAFT_NOT_COMPLETE by progressively adding fields.
// Start with the proven-working empty draft, then add fields one by one.

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
    const errmsg = res.data?.errmsg;
    if (ret === '0' || ret === 0) {
      console.log(`✓ SUCCESS package_id=${res.data?.data?.package_id}`);
      return { ok: true, packageId: res.data?.data?.package_id, draftId };
    } else {
      console.log(`✗ ret=${ret} errmsg=${errmsg}`);
      return { ok: false, ret, errmsg };
    }
  } catch (e) {
    const resp = e.response?.data;
    console.log(`✗ err ${e.message.slice(0, 50)}`);
    if (resp) console.log(`     ret=${resp.ret} errmsg=${resp.errmsg}`);
    return { ok: false, err: e.message };
  }
}

async function main() {
  console.log(`\n=== Draft Bisect Test ===`);
  const api = new CapCutDirectAPI();
  await api._init();

  // Upload asset
  console.log('Uploading asset...');
  const asset = await api.uploadAsset(TEST_IMAGE);
  console.log(`✓ vid=${asset.vid}\n`);
  const fileName = path.basename(TEST_IMAGE);
  const durationUs = 5_000_000;
  const pkgAssets = [{ source_path: fileName, md5: asset.md5, size: asset.fileSize }];

  // Base empty draft (proven to work)
  const baseEmpty = (overrides = {}) => ({
    type: 5,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    duration: 0,
    version: '1.0.0',
    tracks: [],
    pages: [],
    materials: { videos: [], images: [], audios: [], texts: [], effects: [], stickers: [], filters: [], transitions: [] },
    ...overrides,
  });

  const results = [];

  // T1: Proven empty draft (sanity check)
  results.push({ label: 'T1-empty', ...(await trySave(api, 'T1-empty', baseEmpty())) });

  // T2: Empty draft but duration > 0
  results.push({ label: 'T2-duration-only', ...(await trySave(api, 'T2-duration-only', baseEmpty({ duration: durationUs }))) });

  // T3: Empty draft + empty tracks[0]
  results.push({ label: 'T3-empty-track', ...(await trySave(api, 'T3-empty-track', baseEmpty({
    duration: durationUs,
    tracks: [{ id: 't1', type: 'video', segments: [] }],
  }))) });

  // T4: Empty draft + tracks[0] + segment with material_id but no clip
  results.push({ label: 'T4-seg-no-clip', ...(await trySave(api, 'T4-seg-no-clip', baseEmpty({
    duration: durationUs,
    tracks: [{ id: 't1', type: 'video', segments: [{
      id: 's1', material_id: 'mat1',
      source_timerange: { start: 0, duration: durationUs },
      target_timerange: { start: 0, duration: durationUs },
    }] }],
  }))) });

  // T5: T4 + clip
  results.push({ label: 'T5-seg-with-clip', ...(await trySave(api, 'T5-seg-with-clip', baseEmpty({
    duration: durationUs,
    tracks: [{ id: 't1', type: 'video', segments: [{
      id: 's1', material_id: 'mat1',
      source_timerange: { start: 0, duration: durationUs },
      target_timerange: { start: 0, duration: durationUs },
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 },
    }] }],
  }))) });

  // T6: T5 + materials.videos[0] minimal
  results.push({ label: 'T6-min-video-mat', ...(await trySave(api, 'T6-min-video-mat', baseEmpty({
    duration: durationUs,
    materials: { videos: [{
      id: 'mat1', type: 'photo',
      material_id: asset.vid,
      material_url: asset.uri,
      md5: asset.md5,
      width: asset.width, height: asset.height, duration: durationUs,
    }], images: [], audios: [], texts: [], effects: [], stickers: [], filters: [], transitions: [] },
    tracks: [{ id: 't1', type: 'video', segments: [{
      id: 's1', material_id: 'mat1',
      source_timerange: { start: 0, duration: durationUs },
      target_timerange: { start: 0, duration: durationUs },
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 },
    }] }],
  }), pkgAssets)) });

  // T7: T6 + more fields on video material (path, source, source_platform)
  results.push({ label: 'T7-fuller-video-mat', ...(await trySave(api, 'T7-fuller-video-mat', baseEmpty({
    duration: durationUs,
    materials: { videos: [{
      id: 'mat1', type: 'photo', path: '',
      media_path: '', local_id: '', has_audio: false,
      material_id: asset.vid, material_name: fileName, material_url: asset.uri,
      video_id: asset.vid, md5: asset.md5, name: fileName,
      width: asset.width, height: asset.height, duration: durationUs,
      source: 0, source_platform: 0,
    }], images: [], audios: [], texts: [], effects: [], stickers: [], filters: [], transitions: [] },
    tracks: [{ id: 't1', type: 'video', segments: [{
      id: 's1', material_id: 'mat1',
      source_timerange: { start: 0, duration: durationUs },
      target_timerange: { start: 0, duration: durationUs },
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 },
    }] }],
  }), pkgAssets)) });

  // T8: T7 + extra segment fields (speed, state, etc.)
  results.push({ label: 'T8-full-segment', ...(await trySave(api, 'T8-full-segment', baseEmpty({
    duration: durationUs,
    materials: { videos: [{
      id: 'mat1', type: 'photo', path: '',
      material_id: asset.vid, material_name: fileName, material_url: asset.uri,
      video_id: asset.vid, md5: asset.md5, name: fileName,
      width: asset.width, height: asset.height, duration: durationUs,
      source: 0, source_platform: 0,
    }], images: [], audios: [], texts: [], effects: [], stickers: [], filters: [], transitions: [] },
    tracks: [{ id: 't1', type: 'video', segments: [{
      id: 's1', material_id: 'mat1',
      source_timerange: { start: 0, duration: durationUs },
      target_timerange: { start: 0, duration: durationUs },
      speed: 1.0,
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 },
      state: 1, is_loop: false, reverse: false, volume: 1.0,
      render_index: 0, visible: true,
    }] }],
  }), pkgAssets)) });

  // T9: image in materials.images[] instead of videos[]
  results.push({ label: 'T9-image-in-images', ...(await trySave(api, 'T9-image-in-images', baseEmpty({
    duration: durationUs,
    materials: { videos: [], images: [{
      id: 'mat1', type: 'photo',
      material_id: asset.vid, material_name: fileName, material_url: asset.uri,
      video_id: asset.vid, md5: asset.md5, name: fileName,
      width: asset.width, height: asset.height, duration: durationUs,
      source: 0, source_platform: 0,
    }], audios: [], texts: [], effects: [], stickers: [], filters: [], transitions: [] },
    tracks: [{ id: 't1', type: 'video', segments: [{
      id: 's1', material_id: 'mat1',
      source_timerange: { start: 0, duration: durationUs },
      target_timerange: { start: 0, duration: durationUs },
      clip: { scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 }, rotation: 0 },
    }] }],
  }), pkgAssets)) });

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`);
  }

  const successes = results.filter(r => r.ok);
  if (successes.length > 1) {
    const first = successes[1]; // skip T1-empty
    console.log(`\n=== First non-trivial SUCCESS: ${first.label} ===`);
    console.log(`  draftId: ${first.draftId}`);
    console.log(`  packageId: ${first.packageId}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
