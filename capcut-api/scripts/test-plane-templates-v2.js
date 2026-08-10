// scripts/test-plane-templates-v2.js
//
// Try more body variants for get_collection_templates and get_template_detail.
// Key insight: getPresetDetail adds `work_space_id` to body — maybe get_template_detail
// needs it too. Also try get_collection_presets and preset_template_detail.

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Test plane endpoints v2 (template ${TEMPLATE_ID}) ===\n`);

  // Try get_collection_presets (lists preset templates)
  console.log('--- /lv/v1/cc_web/plane/get_collection_presets ---');
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
      console.log(`✓ Got ${res.data.data.item_list.length} preset templates`);
      const first = res.data.data.item_list[0];
      console.log('First preset:', JSON.stringify(first, null, 2).slice(0, 1500));
      fs.writeFileSync('./tmp/preset-templates.json', JSON.stringify(res.data, null, 2));

      // Try preset_template_detail with first preset ID
      const presetId = first.web_id || first.id;
      console.log(`\n--- Trying preset_template_detail with id ${presetId} ---`);
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
      if (detailRes.data?.data) {
        console.log('Data keys:', Object.keys(detailRes.data.data));
        if (detailRes.data.data.template_url) {
          console.log('✓✓✓ Got template_url:', detailRes.data.data.template_url);
          fs.writeFileSync('./tmp/preset-detail-success.json', JSON.stringify(detailRes.data, null, 2));

          // Now try get_template_file
          console.log('\n--- Trying get_template_file with template_url ---');
          const fileRes = await api._axios.post(
            'https://edit-api-sg.capcut.com/lv/v1/editor/draft/get_template_file',
            { uris: [detailRes.data.data.template_url] }
          );
          console.log('ret=', fileRes.data?.ret, 'errmsg=', fileRes.data?.errmsg);
          if (fileRes.data?.data) {
            console.log('✓✓✓✓✓✓ Template file fetched!');
            console.log('Data keys:', Object.keys(fileRes.data.data));
            fs.writeFileSync('./tmp/template-file-success.json', JSON.stringify(fileRes.data, null, 2));
            console.log('saved to tmp/template-file-success.json');
          }
        } else {
          console.log('Full response:', JSON.stringify(detailRes.data, null, 2).slice(0, 2000));
        }
      }
    } else {
      console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1500));
    }
  } catch (e) {
    console.log('✗', e.message);
  }

  // Also try get_template_detail with work_space_id added
  console.log('\n--- get_template_detail with work_space_id ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_template_detail',
      {
        sdk_version: '16.1.0',
        enter_from: 'feed',
        app_version: '5.8.0',
        lang: 'en-US',
        region: 'ID',
        template_id: TEMPLATE_ID,
        need_draft: true,
        work_space_id: api.workspaceId,
      }
    );
    console.log('ret=', res.data?.ret, 'errmsg=', res.data?.errmsg);
    if (res.data?.data?.template_url) {
      console.log('✓ Got template_url:', res.data.data.template_url);
    }
  } catch (e) {
    console.log('✗', e.message);
  }

  // Try get_collection_templates with various combinations
  console.log('\n--- get_collection_templates with more variants ---');
  const variants = [
    { category_id: 12023, cursor: '0', count: 5, category_type: 0 },
    { collection_id: 12023, cursor: '0', count: 5, category_type: 0 },
    { category_ids: [12023], cursor: '0', count: 5 },
    { category_id: '12023', cursor: '0', count: 5, scale: 1, canvas_width: 1080, canvas_height: 1920 },
    { cursor: '0', count: 5, scale: 1, canvas_width: 1080, canvas_height: 1920, category_type: 0 },
    { cursor: '', count: 5 },
    { count: 5, cursor: '0', category_id: 0 },
  ];
  for (let i = 0; i < variants.length; i++) {
    const body = {
      sdk_version: '16.1.0',
      enter_from: 'feed',
      app_version: '5.8.0',
      lang: 'en-US',
      region: 'ID',
      ...variants[i],
    };
    process.stdout.write(`Variant ${i + 1}: ${JSON.stringify(variants[i])}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_collection_templates',
        body
      );
      const listLen = res.data?.data?.item_list?.length || 0;
      console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}" item_list=${listLen}`);
      if (res.data?.ret === '0' && listLen > 0) {
        console.log('✓ SUCCESS!');
        console.log(JSON.stringify(res.data, null, 2).slice(0, 3000));
        fs.writeFileSync('./tmp/plane-templates.json', JSON.stringify(res.data, null, 2));

        // Try get_template_detail with first plane template ID
        const firstItem = res.data.data.item_list[0];
        const tid = firstItem.web_id || firstItem.id;
        console.log(`\nTrying get_template_detail with template ${tid} (with work_space_id)`);
        const detailRes = await api._axios.post(
          'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_template_detail',
          {
            sdk_version: '16.1.0',
            enter_from: 'feed',
            app_version: '5.8.0',
            lang: 'en-US',
            region: 'ID',
            template_id: String(tid),
            need_draft: true,
            work_space_id: api.workspaceId,
          }
        );
        console.log('ret=', detailRes.data?.ret, 'errmsg=', detailRes.data?.errmsg);
        if (detailRes.data?.data?.template_url) {
          console.log('✓✓✓ Got template_url:', detailRes.data.data.template_url);
          fs.writeFileSync('./tmp/template-detail-success.json', JSON.stringify(detailRes.data, null, 2));

          // Try get_template_file
          console.log('\nTrying get_template_file with template_url');
          const fileRes = await api._axios.post(
            'https://edit-api-sg.capcut.com/lv/v1/editor/draft/get_template_file',
            { uris: [detailRes.data.data.template_url] }
          );
          console.log('ret=', fileRes.data?.ret, 'errmsg=', fileRes.data?.errmsg);
          if (fileRes.data?.data) {
            console.log('✓✓✓✓✓✓ Template file fetched!');
            console.log('Data keys:', Object.keys(fileRes.data.data));
            fs.writeFileSync('./tmp/template-file-success.json', JSON.stringify(fileRes.data, null, 2));
          }
        }
        break;
      }
    } catch (e) {
      console.log('✗', e.message);
    }
  }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
