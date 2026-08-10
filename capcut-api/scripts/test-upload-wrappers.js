// scripts/test-upload-wrappers.js
//
// Try CapCut's wrapper endpoints for upload:
//   /v1/upload_sign — get upload signature
//   /v1/upload/create_upload_task — create VOD upload task
//   /v1/upload/get_upload_task — get task status
//
// These might be simpler than raw VOD API.

import fs from 'node:fs';
import crypto from 'node:crypto';
import axios from 'axios';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Test upload wrappers ===\n`);

  const fileBuf = fs.readFileSync(TEST_IMAGE);
  const fileSize = fileBuf.length;
  const fileName = TEST_IMAGE.split('/').pop();
  const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
  console.log(`File: ${fileName} size=${fileSize} md5=${md5}`);

  // 1. /v1/upload_sign
  console.log('\n--- /v1/upload_sign ---');
  for (const biz of ['web_video', 'replicate', 'temp_file', 'user_avatar']) {
    process.stdout.write(`biz=${biz}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/v1/upload_sign',
        { key_version: 'v5', biz }
      );
      console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
      if (res.data?.data) {
        console.log('  data:', JSON.stringify(res.data.data, null, 2).slice(0, 600));
      }
    } catch (e) {
      console.log('✗', e.message);
      if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 300));
    }
  }

  // 2. /v1/upload/create_upload_task
  console.log('\n--- /v1/upload/create_upload_task ---');
  const uploadBodies = [
    { file_name: fileName, file_size: fileSize, file_type: 'image', md5, workspace_id: api.workspaceId },
    { file_name: fileName, size: fileSize, file_type: 'image', md5, workspace_id: api.workspaceId },
    { file_name: fileName, file_size: fileSize, content_type: 'image/jpeg', md5, workspace_id: api.workspaceId },
    { name: fileName, size: fileSize, type: 'image', md5, workspace_id: api.workspaceId },
    { file_name: fileName, file_size: fileSize, file_type: 'image', md5, space_id: '7671928862355588103', workspace_id: api.workspaceId },
  ];
  for (let i = 0; i < uploadBodies.length; i++) {
    process.stdout.write(`Variant ${i + 1}: ${JSON.stringify(uploadBodies[i]).slice(0, 100)}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/v1/upload/create_upload_task',
        uploadBodies[i]
      );
      console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
      if (res.data?.data) {
        console.log('  data:', JSON.stringify(res.data.data, null, 2).slice(0, 800));
      }
    } catch (e) {
      console.log('✗', e.message);
    }
  }

  // 3. Also try /lv/v1/asset/list to see if we have any existing assets
  console.log('\n--- /lv/v1/asset/list ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/asset/list',
      { workspace_id: api.workspaceId, count: 10, cursor: '0' }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
    }
  } catch (e) { console.log('✗', e.message); }

  // 4. Try /lv/v1/draft/get_package_info with our saved draft
  console.log('\n--- /lv/v1/draft/get_package_info (with saved draft) ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/draft/get_package_info',
      { package_id: '7672187086258045456', workspace_id: api.workspaceId }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('data keys:', Object.keys(res.data.data));
      console.log('data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
    }
  } catch (e) { console.log('✗', e.message); }

  // 5. Try get_draft_detail with the ORIGINAL package_key (not the returned package_id)
  console.log('\n--- get_draft_detail with original package_key ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/get_draft_detail',
      {
        package_key: '1786320257190272', // the original package_key we generated
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
      console.log('data keys:', Object.keys(res.data.data));
    }
  } catch (e) { console.log('✗', e.message); }

  // 6. Try get_draft_detail with draft_id field instead of package_key
  console.log('\n--- get_draft_detail with draft_id field ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/get_draft_detail',
      {
        draft_id: '7672187086258045456',
        workspace_id: api.workspaceId,
      }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('data keys:', Object.keys(res.data.data));
    }
  } catch (e) { console.log('✗', e.message); }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
