// scripts/test-everphoto-user.js
//
// Set up ever_photo user (which is required for some endpoints like
// get_collection_presets, preset_template_detail, sync_template_asset).
// The editor calls /cc/v1/workspace/get_all_everphoto_user during init.

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log('\n=== Set up ever_photo user ===\n');

  // Step 1: get_all_everphoto_user — this might create/return the ever_photo user
  console.log('--- /cc/v1/workspace/get_all_everphoto_user ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/get_all_everphoto_user',
      { workspace_id: api.workspaceId }
    );
    console.log('HTTP', res.status);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 2000));
    fs.writeFileSync('./tmp/everphoto-users.json', JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 800));
  }

  // Step 2: get_ever_photo_token (after ever_photo user is set up)
  console.log('\n--- /cc/v1/workspace/get_ever_photo_token (after ever_photo user) ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/get_ever_photo_token',
      { workspace_id: api.workspaceId }
    );
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 2000));
  } catch (e) {
    console.log('✗', e.message);
  }

  // Step 3: retry get_collection_presets
  console.log('\n--- retry /lv/v1/cc_web/plane/get_collection_presets ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_collection_presets',
      {
        sdk_version: '16.1.0',
        enter_from: 'feed',
        count: 5,
        lang: 'en-US',
        cursor: '0',
      }
    );
    console.log('ret=', res.data?.ret, 'errmsg=', res.data?.errmsg);
    if (res.data?.data?.item_list?.length > 0) {
      console.log(`✓ Got ${res.data.data.item_list.length} presets`);
      const first = res.data.data.item_list[0];
      console.log('First preset:', JSON.stringify(first, null, 2).slice(0, 1500));
      fs.writeFileSync('./tmp/preset-templates.json', JSON.stringify(res.data, null, 2));

      // Try preset_template_detail
      const presetId = first.web_id || first.id;
      console.log(`\n--- preset_template_detail with id ${presetId} ---`);
      const detailRes = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/preset_template_detail',
        {
          sdk_version: '16.1.0',
          enter_from: 'feed',
          app_version: '5.8.0',
          lang: 'en-US',
          region: 'ID',
          template_id: String(presetId),
          need_draft: true,
          work_space_id: api.workspaceId,
        }
      );
      console.log('ret=', detailRes.data?.ret, 'errmsg=', detailRes.data?.errmsg);
      if (detailRes.data?.data?.template_url) {
        console.log('✓✓✓ Got template_url:', detailRes.data.data.template_url);
        fs.writeFileSync('./tmp/preset-detail-success.json', JSON.stringify(detailRes.data, null, 2));

        // Try get_template_file
        const fileRes = await api._axios.post(
          'https://edit-api-sg.capcut.com/lv/v1/editor/draft/get_template_file',
          { uris: [detailRes.data.data.template_url] }
        );
        console.log('ret=', fileRes.data?.ret, 'errmsg=', fileRes.data?.errmsg);
        if (fileRes.data?.data) {
          console.log('✓✓✓✓✓ Template file fetched!');
          fs.writeFileSync('./tmp/template-file-success.json', JSON.stringify(fileRes.data, null, 2));
          console.log('Data keys:', Object.keys(fileRes.data.data));
        }
      } else {
        console.log('Response:', JSON.stringify(detailRes.data, null, 2).slice(0, 1500));
      }
    }
  } catch (e) {
    console.log('✗', e.message);
  }

  // Step 4: Also try mget_workspace_info — captures showed this is called
  console.log('\n--- /cc/v1/workspace/mget_workspace_info ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/mget_workspace_info',
      { workspace_ids: [api.workspaceId] }
    );
    console.log('ret=', res.data?.ret, 'errmsg=', res.data?.errmsg);
    if (res.data?.data) {
      console.log('Workspace info keys:', Object.keys(res.data.data));
      const wsInfo = Array.isArray(res.data.data.workspace_infos) ? res.data.data.workspace_infos[0] : res.data.data;
      console.log('First ws info keys:', Object.keys(wsInfo || {}).slice(0, 20));
    }
  } catch (e) {
    console.log('✗', e.message);
  }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
