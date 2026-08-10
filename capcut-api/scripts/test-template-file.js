// scripts/test-template-file.js
//
// Try fetching template file directly with various URI formats.
// The bundle says getTemplateFile(e) takes uris: e (an array).
// What format are these URIs? Maybe just the template_id?

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Test getTemplateFile (template ${TEMPLATE_ID}) ===\n`);

  // Try multiple URI formats
  const uriVariants = [
    [TEMPLATE_ID],
    [`/lv/v1/editor/draft/get_template_file/${TEMPLATE_ID}`],
    [`template:${TEMPLATE_ID}`],
    [`templates/${TEMPLATE_ID}`],
    [`editor/${TEMPLATE_ID}`],
    [`draft/${TEMPLATE_ID}`],
    [`package/${TEMPLATE_ID}`],
  ];

  for (const uris of uriVariants) {
    process.stdout.write(`uris=${JSON.stringify(uris)}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/editor/draft/get_template_file',
        { uris }
      );
      const ret = res.data?.ret;
      const hasData = !!res.data?.data;
      const dataKeys = res.data?.data ? Object.keys(res.data.data).slice(0, 5) : [];
      console.log(`ret=${ret} errmsg="${res.data?.errmsg || ''}" hasData=${hasData} dataKeys=${JSON.stringify(dataKeys)}`);
      if (ret === '0' || ret === 0) {
        console.log('\n✓ SUCCESS!');
        console.log(JSON.stringify(res.data, null, 2).slice(0, 3000));
        fs.writeFileSync('./tmp/template-file-success.json', JSON.stringify(res.data, null, 2));
        break;
      }
    } catch (e) {
      console.log('✗', e.message);
    }
  }

  // Also try the public landing_page endpoint to see if it has more template metadata
  console.log('\n--- Try public landing_page/get_template_detail (no auth) ---');
  try {
    const axios = (await import('axios')).default;
    const res = await axios.get('https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_similar_templates', {
      params: {
        keyword: 'social',
        category: 'social',
        tabs: 'video',
        region_code: 'tw',
        language: 'zh-tw',
        cursor: '',
        size: 3,
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://www.capcut.com/zh-tw/template',
      },
      timeout: 15000,
    });
    const list = res.data?.data?.video_template_list?.video_template_list || [];
    console.log(`Got ${list.length} templates`);
    if (list.length > 0) {
      console.log('First template keys:', Object.keys(list[0]));
      console.log('First template (truncated):', JSON.stringify(list[0], null, 2).slice(0, 1500));
      // Look for any field that might be a "draft_id" or "create_id" or "uri"
      const t = list[0];
      const interestingFields = Object.entries(t).filter(([k, v]) =>
        /id|uri|url|key|draft|file|package|create/i.test(k) && (typeof v === 'string' || typeof v === 'number')
      );
      console.log('\nID-like fields:', interestingFields);
    }
  } catch (e) {
    console.log('✗', e.message);
  }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
