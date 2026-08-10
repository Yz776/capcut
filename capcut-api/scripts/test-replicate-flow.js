// scripts/test-replicate-flow.js
//
// Try replicate template endpoints (which is what /templates listing uses).
// Also try ever_photo/sync_template_asset with the token we now have.

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Test replicate + everphoto flow (template ${TEMPLATE_ID}) ===\n`);

  // Get ever_photo token first
  console.log('--- Get ever_photo token ---');
  let everphotoToken = '';
  let everphotoUserId = '';
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/get_ever_photo_token',
      { workspace_id: api.workspaceId }
    );
    if (res.data?.data?.token) {
      everphotoToken = res.data.data.token;
      everphotoUserId = res.data.data.ever_photo_user?.web_user_id || '';
      console.log(`✓ Got token (len=${everphotoToken.length}) user_id=${everphotoUserId}`);
    }
  } catch (e) { console.log('✗', e.message); }

  // 1. Try replicate get_collection_templates
  console.log('\n--- /lv/v1/cc_web/replicate/get_collection_templates ---');
  const bodies = [
    { category_id: 0, cursor: '0', count: 5 },
    { cursor: '0', count: 5 },
    { collection_id: 0, cursor: '0', count: 5 },
    { biz_id: null, cursor: '0', count: 5 },
    { category: 'social', cursor: '0', count: 5 },
  ];
  for (let i = 0; i < bodies.length; i++) {
    const body = { ...bodies[i] };
    process.stdout.write(`Variant ${i + 1}: ${JSON.stringify(body)}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/cc_web/replicate/get_collection_templates',
        body
      );
      const listLen = res.data?.data?.templates?.length || res.data?.data?.item_list?.length || 0;
      console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}" list=${listLen}`);
      if (res.data?.ret === '0' && listLen > 0) {
        console.log('✓ SUCCESS!');
        fs.writeFileSync('./tmp/replicate-templates.json', JSON.stringify(res.data, null, 2));
        const list = res.data.data.templates || res.data.data.item_list;
        console.log('First template:', JSON.stringify(list[0], null, 2).slice(0, 1500));
        break;
      }
    } catch (e) { console.log('✗', e.message); }
  }

  // 2. Try replicate get_recommended_templates
  console.log('\n--- /lv/v1/cc_web/replicate/get_recommended_templates ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/cc_web/replicate/get_recommended_templates',
      { cursor: '0', count: 5, lang: 'en-US' }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data?.templates?.length > 0) {
      console.log(`✓ Got ${res.data.data.templates.length} recommended templates`);
      fs.writeFileSync('./tmp/recommended-templates.json', JSON.stringify(res.data, null, 2));
      console.log('First:', JSON.stringify(res.data.data.templates[0], null, 2).slice(0, 1000));
    }
  } catch (e) { console.log('✗', e.message); }

  // 3. Try ever_photo/sync_template_asset with Authorization header
  console.log('\n--- /lv/v1/ever_photo/sync_template_asset (with token) ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/ever_photo/sync_template_asset',
      {
        template_id: TEMPLATE_ID,
        workspace_id: api.workspaceId,
        space_id: '7671928862355588103',
      },
      { headers: { Authorization: `Bearer ${everphotoToken}` } }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
    }
  } catch (e) { console.log('✗', e.message); }

  // 4. Try space_host direct (evercloud API)
  console.log('\n--- Direct evercloud API call ---');
  try {
    const res = await api._axios.post(
      'https://sdksggcp32-normal.evercloud.capcutapi.com/api/v1/template/get',
      { template_id: TEMPLATE_ID },
      { headers: { Authorization: `Bearer ${everphotoToken}` } }
    );
    console.log(`HTTP ${res.status} ret=${res.data?.ret}`);
    if (res.data) console.log(JSON.stringify(res.data, null, 2).slice(0, 1000));
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 500));
  }

  // 5. Try /lv/v1/ever_photo/get_external_download_url
  console.log('\n--- /lv/v1/ever_photo/get_external_download_url ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/ever_photo/get_external_download_url',
      {
        asset_id: TEMPLATE_ID,
        workspace_id: api.workspaceId,
        max_time: 3600,
        ttl: 3600,
      }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
    }
  } catch (e) { console.log('✗', e.message); }

  // 6. Try /lv/v1/draft/get_package_info
  console.log('\n--- /lv/v1/draft/get_package_info ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/draft/get_package_info',
      { package_id: TEMPLATE_ID, workspace_id: api.workspaceId }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
    }
  } catch (e) { console.log('✗', e.message); }

  // 7. Try /create_onboard_draft — might create a new empty draft
  console.log('\n--- /cc/v1/workspace/create_onboard_draft ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/create_onboard_draft',
      {
        workspace_id: api.workspaceId,
        space_id: '7671928862355588103',
        template_id: TEMPLATE_ID,
      }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
      fs.writeFileSync('./tmp/onboard-draft.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) { console.log('✗', e.message); }

  // 8. Try /lv/v1/cc_web/plane/get_collection_templates with different category_id types
  //    Use the collection ID 12023 (Most popular) which had 264 resources
  console.log('\n--- plane/get_collection_templates (more variants) ---');
  const planeBodies = [
    { category_id: '12023', cursor: '0', count: 5 },
    { collection_id: '12023', cursor: '0', count: 5 },
    { id: '12023', cursor: '0', count: 5 },
    { category_id: 12023, cursor: 0, count: 5 },
    { cat_id: 12023, cursor: '0', count: 5 },
    { cat_id: '12023', cursor: '0', count: 5 },
  ];
  for (let i = 0; i < planeBodies.length; i++) {
    const body = {
      sdk_version: '16.1.0',
      enter_from: 'feed',
      app_version: '5.8.0',
      lang: 'en-US',
      region: 'ID',
      ...planeBodies[i],
    };
    process.stdout.write(`Variant ${i + 1}: ${JSON.stringify(planeBodies[i])}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_collection_templates',
        body
      );
      const listLen = res.data?.data?.item_list?.length || 0;
      console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}" list=${listLen}`);
      if (res.data?.ret === '0' && listLen > 0) {
        console.log('✓ SUCCESS!');
        fs.writeFileSync('./tmp/plane-templates.json', JSON.stringify(res.data, null, 2));
        break;
      }
    } catch (e) { console.log('✗', e.message); }
  }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
