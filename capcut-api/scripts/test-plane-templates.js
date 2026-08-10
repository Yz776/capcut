// scripts/test-plane-templates.js
//
// List plane templates using /lv/v1/cc_web/plane/get_collection_templates
// Schema from bundle-035.js offset 459280:
//   body = {sdk_version:'16.1.0', enter_from:'feed', count:20, lang, ...userInput}
//   response = {new_cursor, has_more, item_list:[{web_id, id, sign_info, ...}]}

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log('\n=== List plane templates ===\n');

  // Try various body field combinations
  const bodies = [
    // Variant 1: collection_id from get_collections
    { collection_id: 12036, cursor: '0', count: 5 },  // Father's Day
    // Variant 2: category_id
    { category_id: 12036, cursor: '0', count: 5 },
    // Variant 3: id
    { id: 12036, cursor: '0', count: 5 },
    // Variant 4: just cursor and count
    { cursor: '0', count: 5 },
    // Variant 5: with category_id as string
    { category_id: '12036', cursor: '0', count: 5 },
    // Variant 6: collection_id and category_id
    { collection_id: 12036, category_id: 0, cursor: '0', count: 5 },
    // Variant 7: just collection_id (no cursor)
    { collection_id: 12036, count: 5 },
  ];

  for (let i = 0; i < bodies.length; i++) {
    const body = {
      sdk_version: '16.1.0',
      enter_from: 'feed',
      count: 5,
      lang: 'en-US',
      region: 'ID',
      app_version: '5.8.0',
      ...bodies[i],
    };
    process.stdout.write(`\nVariant ${i + 1}: ${JSON.stringify(bodies[i])}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_collection_templates',
        body
      );
      const ret = res.data?.ret;
      const listLen = res.data?.data?.item_list?.length || 0;
      console.log(`ret=${ret} errmsg="${res.data?.errmsg || ''}" item_list=${listLen}`);
      if (ret === '0' && listLen > 0) {
        console.log('\n✓ SUCCESS! Full response:');
        console.log(JSON.stringify(res.data, null, 2).slice(0, 4000));
        fs.writeFileSync('./tmp/plane-templates.json', JSON.stringify(res.data, null, 2));
        console.log('\nsaved to tmp/plane-templates.json');

        // Try get_template_detail with the first template
        const firstItem = res.data.data.item_list[0];
        const templateId = firstItem.web_id || firstItem.id;
        console.log(`\n--- Trying get_template_detail with template ${templateId} ---`);
        if (templateId) {
          const detailRes = await api._axios.post(
            'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_template_detail',
            {
              sdk_version: '16.1.0',
              enter_from: 'feed',
              app_version: '5.8.0',
              lang: 'en-US',
              region: 'ID',
              template_id: String(templateId),
              need_draft: true,
            }
          );
          console.log('HTTP', detailRes.status);
          console.log('ret=', detailRes.data?.ret, 'errmsg=', detailRes.data?.errmsg);
          if (detailRes.data?.data?.template_url) {
            console.log('✓ Got template_url:', detailRes.data.data.template_url);
            console.log('  materials:', !!detailRes.data.data.materials);
            console.log('  draft_data:', !!detailRes.data.data.draft_data);
            console.log('  template_data:', !!detailRes.data.data.template_data);
            fs.writeFileSync('./tmp/template-detail-success.json', JSON.stringify(detailRes.data, null, 2));
            console.log('saved to tmp/template-detail-success.json');

            // Try get_template_file with the template_url
            console.log('\n--- Trying get_template_file ---');
            const fileRes = await api._axios.post(
              'https://edit-api-sg.capcut.com/lv/v1/editor/draft/get_template_file',
              { uris: [detailRes.data.data.template_url] }
            );
            console.log('HTTP', fileRes.status, 'ret=', fileRes.data?.ret);
            if (fileRes.data?.data) {
              console.log('Data keys:', Object.keys(fileRes.data.data));
              fs.writeFileSync('./tmp/template-file-success.json', JSON.stringify(fileRes.data, null, 2));
              console.log('saved to tmp/template-file-success.json');
            }
          } else {
            console.log('Response:', JSON.stringify(detailRes.data, null, 2).slice(0, 1500));
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
