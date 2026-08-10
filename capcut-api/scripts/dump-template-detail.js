// scripts/dump-template-detail.js
//
// Dump full response from /lv/v1/cc_web/plane/get_template_detail
// (we saw ret=11001 but data has template_data + draft_data — investigate)

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();
  console.log(`\n=== Dump template detail (template ${TEMPLATE_ID}) ===\n`);

  const res = await api._axios.post(
    'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_template_detail',
    {
      sdk_version: '16.1.0',
      enter_from: 'feed',
      app_version: '5.8.0',
      lang: 'zh-TW',
      region: 'TW',
      template_id: TEMPLATE_ID,
      need_draft: true,
    }
  );

  console.log('Full response (ret, errmsg, data keys):');
  console.log('  ret:', res.data?.ret);
  console.log('  errmsg:', res.data?.errmsg);
  console.log('  data keys:', Object.keys(res.data?.data || {}));

  // Dump template_data
  const td = res.data?.data?.template_data;
  if (td) {
    console.log('\n=== template_data ===');
    if (typeof td === 'string') {
      console.log('Length:', td.length, 'chars');
      console.log('First 5000 chars:');
      console.log(td.slice(0, 5000));
    } else {
      console.log('Type:', typeof td);
      console.log(JSON.stringify(td, null, 2).slice(0, 5000));
    }
  }

  // Dump draft_data
  const dd = res.data?.data?.draft_data;
  if (dd) {
    console.log('\n=== draft_data ===');
    if (typeof dd === 'string') {
      console.log('Length:', dd.length, 'chars');
      console.log('First 5000 chars:');
      console.log(dd.slice(0, 5000));
    } else {
      console.log('Type:', typeof dd);
      console.log(JSON.stringify(dd, null, 2).slice(0, 5000));
    }
  }

  // Dump template_url
  const tu = res.data?.data?.template_url;
  if (tu) {
    console.log('\n=== template_url ===');
    console.log(tu);
  }

  // Dump materials
  const m = res.data?.data?.materials;
  if (m) {
    console.log('\n=== materials ===');
    console.log('Type:', typeof m);
    console.log(JSON.stringify(m, null, 2).slice(0, 5000));
  }

  // Save the full response
  fs.writeFileSync('./tmp/template-detail-full-dump.json', JSON.stringify(res.data, null, 2));
  console.log('\nFull response saved to tmp/template-detail-full-dump.json');

  // If template_data is a JSON string, also save parsed
  if (typeof td === 'string') {
    try {
      const parsed = JSON.parse(td);
      fs.writeFileSync('./tmp/template-data-parsed.json', JSON.stringify(parsed, null, 2));
      console.log('Parsed template_data saved to tmp/template-data-parsed.json');
      console.log('Parsed template_data keys:', Object.keys(parsed));
      if (parsed.materials) console.log('Materials keys:', Object.keys(parsed.materials));
      if (parsed.tracks) console.log('Tracks count:', parsed.tracks.length);
    } catch (e) {
      console.log('Could not parse template_data as JSON:', e.message);
    }
  }
  if (typeof dd === 'string') {
    try {
      const parsed = JSON.parse(dd);
      fs.writeFileSync('./tmp/draft-data-parsed.json', JSON.stringify(parsed, null, 2));
      console.log('Parsed draft_data saved to tmp/draft-data-parsed.json');
      console.log('Parsed draft_data keys:', Object.keys(parsed));
    } catch (e) {
      console.log('Could not parse draft_data as JSON:', e.message);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
