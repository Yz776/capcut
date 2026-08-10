// scripts/test-get-template-draft.js
//
// Try every known template detail endpoint with template_id 7617043391162928401
// to extract the actual template DRAFT JSON structure.
//
// Once we have a real draft, we can use it as a base template for our renders.

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();
  console.log(`\n=== Get template draft content (template ${TEMPLATE_ID}) ===\n`);

  const results = {};

  // === Endpoint 1: /lv/v1/cc_web/plane/get_template_detail ===
  // Public-ish endpoint. Try multiple region/lang combos.
  console.log('--- Endpoint 1: /lv/v1/cc_web/plane/get_template_detail ---');
  for (const { lang, region } of [
    { lang: 'zh-TW', region: 'TW' },
    { lang: 'en-US', region: 'US' },
    { lang: 'en-US', region: 'ID' },
    { lang: 'zh-CN', region: 'CN' },
  ]) {
    const body = {
      sdk_version: '16.1.0',
      enter_from: 'feed',
      app_version: '5.8.0',
      lang, region,
      template_id: TEMPLATE_ID,
      need_draft: true,
    };
    process.stdout.write(`  lang=${lang} region=${region}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_template_detail',
        body
      );
      const ret = res.data?.ret;
      const dataKeys = res.data?.data ? Object.keys(res.data.data) : [];
      console.log(`ret=${ret} keys=${JSON.stringify(dataKeys)}`);
      if (ret === '0' || ret === 0) {
        results.endpoint1 = res.data;
        fs.writeFileSync('./tmp/template-detail-success.json', JSON.stringify(res.data, null, 2));
        console.log('  ✓✓✓ SUCCESS — saved to tmp/template-detail-success.json');
        console.log('  Response preview:', JSON.stringify(res.data, null, 2).slice(0, 1500));
        break;
      }
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }

  // === Endpoint 2: /lv/v1/editor/plane_draft/get_template_detail ===
  // Authenticated editor endpoint.
  console.log('\n--- Endpoint 2: /lv/v1/editor/plane_draft/get_template_detail ---');
  for (const { lang, region } of [
    { lang: 'zh-TW', region: 'TW' },
    { lang: 'en-US', region: 'ID' },
  ]) {
    const body = {
      template_id: TEMPLATE_ID,
      lang, region,
      app_version: '5.8.0',
      sdk_version: '16.1.0',
      workspace_id: api.workspaceId,
      enter_from: 'template_editor',
    };
    process.stdout.write(`  lang=${lang} region=${region}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/get_template_detail',
        body
      );
      const ret = res.data?.ret;
      const dataKeys = res.data?.data ? Object.keys(res.data.data) : [];
      console.log(`ret=${ret} keys=${JSON.stringify(dataKeys)}`);
      if (ret === '0' || ret === 0) {
        results.endpoint2 = res.data;
        fs.writeFileSync('./tmp/plane-template-detail-success.json', JSON.stringify(res.data, null, 2));
        console.log('  ✓✓✓ SUCCESS — saved to tmp/plane-template-detail-success.json');
        break;
      } else {
        console.log('  errmsg:', res.data?.errmsg);
      }
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }

  // === Endpoint 3: /lv/v1/editor/draft/get_template_file ===
  // Direct template file fetch — try various URI formats.
  console.log('\n--- Endpoint 3: /lv/v1/editor/draft/get_template_file ---');
  const uriVariants = [
    [TEMPLATE_ID],
    [`template/${TEMPLATE_ID}`],
    [`/template/${TEMPLATE_ID}`],
    [`draft/${TEMPLATE_ID}`],
    [`package/${TEMPLATE_ID}`],
    [`templates/${TEMPLATE_ID}`],
    [`/lv/v1/editor/draft/get_template_file/${TEMPLATE_ID}`],
  ];
  for (const uris of uriVariants) {
    process.stdout.write(`  uris=${JSON.stringify(uris)}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/editor/draft/get_template_file',
        { uris }
      );
      const ret = res.data?.ret;
      console.log(`ret=${ret} errmsg="${res.data?.errmsg || ''}"`);
      if (ret === '0' || ret === 0) {
        results.endpoint3 = res.data;
        fs.writeFileSync('./tmp/template-file-success.json', JSON.stringify(res.data, null, 2));
        console.log('  ✓✓✓ SUCCESS — saved to tmp/template-file-success.json');
        console.log('  Response preview:', JSON.stringify(res.data, null, 2).slice(0, 1500));
        break;
      }
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }

  // === Endpoint 4: /lv/v1/cc_web/replicate/multi_get_templates ===
  // Returns template metadata (might include draft_uri or asset info).
  console.log('\n--- Endpoint 4: /lv/v1/cc_web/replicate/multi_get_templates ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/cc_web/replicate/multi_get_templates',
      {
        biz_id: null,
        id: [TEMPLATE_ID],
        enter_from: 'template_editor',
        sdk_version: '127.0.0',
        cc_web_version: 0,
      }
    );
    console.log(`  ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('  data keys:', Object.keys(res.data.data));
      results.endpoint4 = res.data;
      fs.writeFileSync('./tmp/replicate-templates.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
  }

  // === Endpoint 5: /lv/v1/editor/plane_draft/get_user_draft_list ===
  // Try to list user's existing drafts to find any real draft we can use as template.
  console.log('\n--- Endpoint 5: try to list user drafts ---');
  const listEndpoints = [
    '/lv/v1/editor/plane_draft/get_user_draft_list',
    '/lv/v1/cc_web/task/get_user_draft_list',
    '/lv/v1/editor/draft/list',
    '/lv/v1/editor/plane_draft/list',
  ];
  for (const ep of listEndpoints) {
    process.stdout.write(`  POST ${ep}: `);
    try {
      const res = await api._axios.post(`https://edit-api-sg.capcut.com${ep}`, {
        cursor: '0',
        count: 10,
        workspace_id: api.workspaceId,
        app_version: '5.8.0',
        sdk_version: '16.1.0',
      });
      console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
      if (res.data?.ret === '0' || res.data?.ret === 0) {
        console.log('  data:', JSON.stringify(res.data?.data, null, 2).slice(0, 1500));
        results.endpoint5 = res.data;
        fs.writeFileSync('./tmp/user-drafts.json', JSON.stringify(res.data, null, 2));
        break;
      }
    } catch (e) {
      console.log(`✗ ${e.message}`);
    }
  }

  // === Summary ===
  console.log('\n=== Summary ===');
  console.log('Successful endpoints:', Object.keys(results));
  for (const [k, v] of Object.entries(results)) {
    console.log(`\n--- ${k} ---`);
    console.log('Top-level keys:', Object.keys(v?.data || {}));
  }

  // If we got a successful template detail, dig into the draft_data
  if (results.endpoint1?.data?.template_data || results.endpoint2?.data?.template_data) {
    const src = results.endpoint1 || results.endpoint2;
    const td = src.data.template_data;
    console.log('\n=== Template data preview ===');
    if (typeof td === 'string') {
      console.log('Length:', td.length, 'chars');
      console.log('First 3000 chars:', td.slice(0, 3000));
    } else {
      console.log(JSON.stringify(td, null, 2).slice(0, 3000));
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
