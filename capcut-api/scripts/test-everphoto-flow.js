// scripts/test-everphoto-flow.js
//
// Try the ever_photo flow:
//   1. /cc/v1/workspace/get_ever_photo_token — get STS token
//   2. /lv/v1/ever_photo/sync_template_asset — sync template asset
//   3. /lv/v1/ever_photo/get_external_download_url — get download URL
//
// Also try /lv/v1/cc_web/replicate/get_collection_templates to see if we can list
// real plane templates that work with get_template_detail.

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Test ever_photo flow (template ${TEMPLATE_ID}) ===\n`);

  // Step 1: Get ever_photo token
  console.log('--- Step 1: /cc/v1/workspace/get_ever_photo_token ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/get_ever_photo_token',
      { workspace_id: api.workspaceId }
    );
    console.log('HTTP', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1500));
    if (res.data?.data) {
      fs.writeFileSync('./tmp/everphoto-token.json', JSON.stringify(res.data, null, 2));
      console.log('saved to tmp/everphoto-token.json');
    }
  } catch (e) {
    console.log('✗ failed:', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 500));
  }

  // Step 2: sync_template_asset
  console.log('\n--- Step 2: /lv/v1/ever_photo/sync_template_asset ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/ever_photo/sync_template_asset',
      { template_id: TEMPLATE_ID, workspace_id: api.workspaceId }
    );
    console.log('HTTP', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1500));
  } catch (e) {
    console.log('✗ failed:', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 500));
  }

  // Step 3: get_collection_templates (plane)
  console.log('\n--- Step 3: /lv/v1/cc_web/plane/get_collection_templates ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_collection_templates',
      {
        sdk_version: '16.1.0',
        enter_from: 'feed',
        app_version: '5.8.0',
        lang: 'en-US',
        region: 'ID',
        category_id: '',
        cursor: '0',
        count: 5,
      }
    );
    console.log('HTTP', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 2500));
    if (res.data?.data?.templates?.length > 0) {
      console.log('\n✓ Got plane templates!');
      fs.writeFileSync('./tmp/plane-templates.json', JSON.stringify(res.data, null, 2));
      // Try get_template_detail with first plane template ID
      const firstId = res.data.data.templates[0].template_id || res.data.data.templates[0].id;
      if (firstId) {
        console.log(`\n--- Trying get_template_detail with plane template ${firstId} ---`);
        const detailRes = await api._axios.post(
          'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_template_detail',
          {
            sdk_version: '16.1.0',
            enter_from: 'feed',
            app_version: '5.8.0',
            lang: 'en-US',
            region: 'ID',
            template_id: firstId,
            need_draft: true,
          }
        );
        console.log('HTTP', detailRes.status);
        console.log('Response:', JSON.stringify(detailRes.data, null, 2).slice(0, 2500));
        if (detailRes.data?.data?.template_url) {
          console.log('\n✓✓✓ Got template_url! Now trying get_template_file...');
          const fileRes = await api._axios.post(
            'https://edit-api-sg.capcut.com/lv/v1/editor/draft/get_template_file',
            { uris: [detailRes.data.data.template_url] }
          );
          console.log('HTTP', fileRes.status);
          console.log('Response keys:', Object.keys(fileRes.data || {}));
          if (fileRes.data?.data) {
            console.log('Data keys:', Object.keys(fileRes.data.data));
            fs.writeFileSync('./tmp/template-file-success.json', JSON.stringify(fileRes.data, null, 2));
            console.log('saved to tmp/template-file-success.json');
          }
        }
      }
    }
  } catch (e) {
    console.log('✗ failed:', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 500));
  }

  // Step 4: Try plane/get_collections to see available collections
  console.log('\n--- Step 4: /lv/v1/cc_web/plane/get_collections ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_collections',
      {
        sdk_version: '16.1.0',
        enter_from: 'feed',
        app_version: '5.8.0',
        lang: 'en-US',
        region: 'ID',
      }
    );
    console.log('HTTP', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 2000));
  } catch (e) {
    console.log('✗ failed:', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 500));
  }

  // Step 5: Try plane/get_categories
  console.log('\n--- Step 5: /lv/v1/cc_web/plane/get_categories ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_categories',
      {
        sdk_version: '16.1.0',
        enter_from: 'feed',
        app_version: '5.8.0',
        lang: 'en-US',
        region: 'ID',
      }
    );
    console.log('HTTP', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 2000));
    if (res.data?.data?.categories?.length > 0) {
      console.log('\n✓ Got categories!');
      fs.writeFileSync('./tmp/plane-categories.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) {
    console.log('✗ failed:', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 500));
  }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
