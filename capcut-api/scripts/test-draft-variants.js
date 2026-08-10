// scripts/test-draft-variants.js
//
// Try multiple draft JSON variants to find what makes CapCut's
// plane_draft/save endpoint happy (currently failing with ret=2009 ERR_DRAFT_NOT_COMPLETE).
//
// Strategy:
//   V1: Empty draft + just materials.videos[0] (no tracks)
//   V2: Empty draft + materials + empty tracks[]
//   V3: Full draft with materials + tracks (the one that's failing)
//   V4: Same as V3 but with version "3.0.0" instead of "1.0.0"
//   V5: V3 but with material type="video" instead of "photo"
//   V6: V3 but without source_timerange (just target_timerange)
//   V7: V3 but with extra required segment fields like source: 0
//   V8: V3 but with cover_image_content set

import fs from 'node:fs';
import path from 'node:path';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function tryVariant(api, label, draftData, asset, fileName) {
  const draftId = String(Date.now()) + Math.floor(Math.random() * 1000) + '_' + label;
  // Update draft ID and any material IDs that should match
  draftData.id = draftId;
  if (draftData.materials?.videos?.[0]) {
    draftData.materials.videos[0].id = 'mat-' + draftId;
  }
  if (draftData.tracks?.[0]?.segments?.[0]) {
    draftData.tracks[0].segments[0].material_id = 'mat-' + draftId;
    draftData.tracks[0].segments[0].id = 'seg-' + draftId;
  }
  if (draftData.tracks?.[0]) {
    draftData.tracks[0].id = 'track-' + draftId;
  }

  process.stdout.write(`  [${label}] `);
  try {
    const result = await api.saveDraft(draftData, {
      packageKey: draftId,
      videoName: `Test ${label}`,
      materials: draftData.materials,
      packageAssets: [{
        source_path: fileName,
        md5: asset.md5,
        size: asset.fileSize,
      }],
    });
    console.log(`✓ SUCCESS! package_id=${result.package_id}`);
    return { ok: true, result, draftId };
  } catch (e) {
    const errMsg = e.message?.slice(0, 100);
    const respData = e.response?.data;
    console.log(`✗ ${errMsg}`);
    if (respData) console.log(`     ret=${respData.ret} errmsg=${respData.errmsg}`);
    return { ok: false, err: e, draftId };
  }
}

async function main() {
  console.log(`\n=== Try Multiple Draft Variants ===`);
  const api = new CapCutDirectAPI();
  await api._init();
  console.log(`workspaceId=${api.workspaceId}\n`);

  // Upload asset
  console.log('Uploading asset...');
  const asset = await api.uploadAsset(TEST_IMAGE);
  console.log(`✓ vid=${asset.vid} w=${asset.width} h=${asset.height}\n`);

  const fileName = path.basename(TEST_IMAGE);
  const durationUs = 5_000_000;

  // Common material template
  const makeVideoMaterial = (overrides = {}) => ({
    id: 'mat-X',
    type: 'photo',
    path: '',
    media_path: '',
    local_id: '',
    has_audio: false,
    width: asset.width || 1080,
    height: asset.height || 1920,
    duration: durationUs,
    material_id: asset.vid,
    material_name: fileName,
    material_url: asset.uri,
    source: 0,
    source_platform: 0,
    md5: asset.md5,
    video_id: asset.vid,
    name: fileName,
    ...overrides,
  });

  const makeSegment = (materialId, overrides = {}) => ({
    id: 'seg-X',
    material_id: materialId,
    source_timerange: { start: 0, duration: durationUs },
    target_timerange: { start: 0, duration: durationUs },
    speed: 1.0,
    clip: { scale: { x: 1.0, y: 1.0 }, transform: { x: 0, y: 0 }, rotation: 0 },
    ...overrides,
  });

  const makeTrack = (segments, overrides = {}) => ({
    id: 'track-X',
    type: 'video',
    segments,
    ...overrides,
  });

  const baseMaterials = (videos = []) => ({
    videos,
    audios: [],
    texts: [],
    effects: [],
    stickers: [],
    filters: [],
    transitions: [],
    images: [],
    raw_materials: [],
  });

  // === V1: Only materials (no tracks) ===
  const v1 = {
    type: 5,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    duration: durationUs,
    create_time: Date.now(),
    update_time: Date.now(),
    version: '1.0.0',
    fps: 30,
    ratio: '9:16',
    materials: baseMaterials([makeVideoMaterial()]),
    tracks: [],
  };

  // === V2: Empty materials + empty tracks (proven to work) ===
  const v2 = {
    type: 5,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    duration: 0,
    version: '1.0.0',
    materials: baseMaterials(),
    tracks: [],
  };

  // === V3: Full draft with materials + tracks (the failing one) ===
  const mat3 = makeVideoMaterial();
  const v3 = {
    type: 5,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    duration: durationUs,
    create_time: Date.now(),
    update_time: Date.now(),
    version: '1.0.0',
    fps: 30,
    ratio: '9:16',
    materials: baseMaterials([mat3]),
    tracks: [makeTrack([makeSegment(mat3.id)])],
  };

  // === V4: V3 but with version 3.0.0 ===
  const mat4 = makeVideoMaterial();
  const v4 = { ...JSON.parse(JSON.stringify(v3)), version: '3.0.0', materials: baseMaterials([mat4]), tracks: [makeTrack([makeSegment(mat4.id)])] };

  // === V5: V3 but material type="video" (instead of "photo") ===
  const mat5 = makeVideoMaterial({ type: 'video', has_audio: true });
  const v5 = { ...JSON.parse(JSON.stringify(v3)), materials: baseMaterials([mat5]), tracks: [makeTrack([makeSegment(mat5.id)])] };

  // === V6: V3 but with extra segment fields from bundle ===
  const mat6 = makeVideoMaterial();
  const seg6 = makeSegment(mat6.id, {
    desc: '',
    state: 1,
    is_loop: false,
    is_tone_modify: false,
    reverse: false,
    intensifies_audio: false,
    cartoon: false,
    volume: 1.0,
    last_nonzero_volume: 1.0,
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
  });
  const v6 = { ...JSON.parse(JSON.stringify(v3)), materials: baseMaterials([mat6]), tracks: [makeTrack([seg6])] };

  // === V7: V3 but with material in materials.images[] instead of videos[] ===
  const mat7 = makeVideoMaterial();
  const v7 = { ...JSON.parse(JSON.stringify(v3)), materials: { ...baseMaterials(), images: [mat7] }, tracks: [makeTrack([makeSegment(mat7.id)])] };

  // === V8: V3 with both videos[0] AND images[0] (CapCut might want both) ===
  const mat8 = makeVideoMaterial();
  const v8 = { ...JSON.parse(JSON.stringify(v3)), materials: { ...baseMaterials([mat8]), images: [mat8] }, tracks: [makeTrack([makeSegment(mat8.id)])] };

  const variants = [
    { label: 'V1-materials-only-no-tracks', data: v1 },
    { label: 'V2-empty', data: v2 },
    { label: 'V3-full-photo', data: v3 },
    { label: 'V4-version-3', data: v4 },
    { label: 'V5-type-video', data: v5 },
    { label: 'V6-full-segment-fields', data: v6 },
    { label: 'V7-images-only', data: v7 },
    { label: 'V8-videos+images', data: v8 },
  ];

  const results = [];
  for (const v of variants) {
    const res = await tryVariant(api, v.label, JSON.parse(JSON.stringify(v.data)), asset, fileName);
    results.push({ label: v.label, ...res });
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`);
  }

  const successes = results.filter(r => r.ok);
  if (successes.length > 0) {
    const first = successes[0];
    console.log(`\n=== First SUCCESS: ${first.label} ===`);
    console.log(`  draftId: ${first.draftId}`);
    console.log(`  package_id: ${first.result.package_id}`);
    // Save the winning draft variant
    fs.writeFileSync('./tmp/winning-draft-variant.json', JSON.stringify({
      label: first.label,
      draftId: first.draftId,
      packageId: first.result.package_id,
    }, null, 2));
    console.log('Saved to tmp/winning-draft-variant.json');
  } else {
    console.log('\n✗ All variants failed. Need to investigate further.');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
