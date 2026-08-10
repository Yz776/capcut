// scripts/test-save-draft.js
//
// Try saving minimal drafts via /lv/v1/editor/plane_draft/save to discover
// the required body schema. Start with empty content and iterate based on errors.
//
// Body schema (from bundle-035.js offset 451051):
//   {workspace_id, package_type:5, package_key, base_package_id:"0",
//    template_data (string), template_meta (stringified),
//    package_assets:[], referenced_assets:[], materials, user_actions:"{}",
//    cover_image_content, page_covers:[]}

import fs from 'node:fs';
import crypto from 'node:crypto';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log('\n=== Test save minimal draft ===\n');

  // Generate a draft ID (package_key)
  const draftId = String(Date.now()) + Math.floor(Math.random() * 1000);
  console.log(`Generated draft ID: ${draftId}`);

  // Minimal template_data — try empty first
  const minimalDraftData = JSON.stringify({
    id: draftId,
    type: 5,
    tracks: [],
    pages: [],
    materials: { videos: [], images: [], audios: [], texts: [], effects: [], stickers: [], filters: [], transitions: [] },
    duration: 0,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    version: '1.0.0',
  });

  // Minimal template_meta (stringified)
  const minimalMeta = JSON.stringify({
    draft: {
      id: draftId,
      name: 'Test Draft',
      type: 5,
      duration: 0,
      updateTime: Date.now(),
      size: 0,
      segmentCount: 0,
      version: '1.0.0',
      platformSupport: 'browser',
      isMainTrackEmpty: true,
      isScriptTemplate: false,
      renderIndexTrackMode: false,
      canvasInfo: { width: 1080, height: 1920, sizeUnit: 'px', pageInfoList: [{ width: 1080, height: 1920, sizeUnit: 'px', unit: 'px' }] },
      coverUrl: 'cover.jpg',
      cover: 'cover.jpg',
      graphicInfo: { isUseInCn: false, isBatch: false },
    },
    uploadSource: {
      owner: api.userId,
      platform: 'browser',
      systemVersion: 'Mozilla/5.0',
      appVersion: '1.0.0',
      createTime: Date.now(),
    },
    createSource: {
      owner: api.userId,
      platform: 'browser',
      systemVersion: 'Mozilla/5.0',
      appVersion: '1.0.0',
      createTime: Date.now(),
    },
  });

  const body = {
    workspace_id: api.workspaceId,
    package_type: 5,
    package_key: draftId,
    base_package_id: '0',
    template_data: minimalDraftData,
    template_meta: minimalMeta,
    package_assets: [],
    referenced_assets: [],
    materials: {},
    user_actions: '{}',
    cover_image_content: '',
    page_covers: [],
  };

  console.log('\n--- Attempt 1: minimal draft ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/save',
      body
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    console.log('Full response:', JSON.stringify(res.data, null, 2).slice(0, 2000));
    if (res.data?.ret === '0' || res.data?.ret === 0) {
      console.log('\n✓✓✓ DRAFT SAVED!');
      fs.writeFileSync('./tmp/draft-saved.json', JSON.stringify(res.data, null, 2));
      console.log('draft_id:', res.data?.data?.draft_id || res.data?.data?.package_key);
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 1500));
  }

  // Attempt 2: try with cover_image_content as minimal base64
  console.log('\n--- Attempt 2: with minimal cover_image_content ---');
  try {
    // 1x1 black JPEG base64 (without data: prefix)
    const minimalCover = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpgD/9k=';
    const body2 = { ...body, cover_image_content: minimalCover, page_covers: [{ data: minimalCover, source_path: 'cover.jpg' }] };
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/save',
      body2
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.ret === '0' || res.data?.ret === 0) {
      console.log('✓✓✓ DRAFT SAVED with cover!');
      fs.writeFileSync('./tmp/draft-saved.json', JSON.stringify(res.data, null, 2));
    } else {
      console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1000));
    }
  } catch (e) { console.log('✗', e.message); }

  // Attempt 3: try the video_draft/save endpoint instead
  console.log('\n--- Attempt 3: /lv/v1/editor/video_draft/save ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/editor/video_draft/save',
      body
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1000));
  } catch (e) { console.log('✗', e.message); }

  // Attempt 4: try /editor/video_draft/save
  console.log('\n--- Attempt 4: /editor/video_draft/save ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/editor/video_draft/save',
      body
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1000));
  } catch (e) { console.log('✗', e.message); }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
