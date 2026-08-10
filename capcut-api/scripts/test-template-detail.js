// scripts/test-template-detail.js
//
// Test the corrected getTemplateDetail endpoint against live CapCut API.
// Tries multiple region/lang combinations since templates are region-locked.

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEMPLATE_ID = process.argv[2] || '7617043391162928401';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Test getTemplateDetail (template ${TEMPLATE_ID}) ===\n`);

  // Region/lang combinations — templates are region-locked, must match
  const variants = [
    { lang: 'zh-TW', region: 'TW' },
    { lang: 'en-US', region: 'US' },
    { lang: 'zh-TW', region: 'HK' },
    { lang: 'en-US', region: 'ID' },
    { lang: 'zh-CN', region: 'CN' },
    { lang: 'en-US', region: 'SG' },
    { lang: 'en', region: 'ID' },
  ];

  let success = false;
  for (const v of variants) {
    const body = {
      sdk_version: '16.1.0',
      enter_from: 'feed',
      app_version: '5.8.0',
      lang: v.lang,
      region: v.region,
      template_id: TEMPLATE_ID,
      need_draft: true,
    };
    process.stdout.write(`lang=${v.lang} region=${v.region}: `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_template_detail',
        body
      );
      const ret = res.data?.ret;
      const hasUrl = !!res.data?.data?.template_url;
      const hasData = !!res.data?.data?.template_data;
      const hasDraft = !!res.data?.data?.draft_data;
      console.log(`ret=${ret} errmsg="${res.data?.errmsg || ''}" template_url=${hasUrl} template_data=${hasData} draft_data=${hasDraft}`);
      if (ret === '0' || ret === 0) {
        console.log('\n✓ SUCCESS! Full response (first 3000 chars):');
        console.log(JSON.stringify(res.data, null, 2).slice(0, 3000));
        fs.writeFileSync('./tmp/template-detail-success.json', JSON.stringify(res.data, null, 2));
        console.log('\nsaved to tmp/template-detail-success.json');
        success = true;
        break;
      }
    } catch (e) {
      console.log('✗ failed:', e.message);
    }
  }

  if (!success) {
    console.log('\n✗ All region variants failed for this template ID');
    console.log('\nTrying a different template ID...');
    // The /templates endpoint returned these IDs as TW region templates — try them all
    const otherTemplates = [
      '7568498138453937413', // Social Activity
      '7642759375127432465', // Social Media Pro
      '7542136622209453365', // AÇÃO SOCIAL
      '7616481228962712848', // Social Media
    ];
    for (const tid of otherTemplates) {
      process.stdout.write(`\nTrying template ${tid} (lang=zh-TW region=TW): `);
      try {
        const res = await api._axios.post(
          'https://edit-api-sg.capcut.com/lv/v1/cc_web/plane/get_template_detail',
          {
            sdk_version: '16.1.0',
            enter_from: 'feed',
            app_version: '5.8.0',
            lang: 'zh-TW',
            region: 'TW',
            template_id: tid,
            need_draft: true,
          }
        );
        const ret = res.data?.ret;
        const hasUrl = !!res.data?.data?.template_url;
        console.log(`ret=${ret} errmsg="${res.data?.errmsg || ''}" template_url=${hasUrl}`);
        if (ret === '0' || ret === 0) {
          console.log('✓ SUCCESS!');
          fs.writeFileSync('./tmp/template-detail-success.json', JSON.stringify(res.data, null, 2));
          console.log('saved to tmp/template-detail-success.json');
          console.log('\nResponse (first 2000 chars):');
          console.log(JSON.stringify(res.data, null, 2).slice(0, 2000));
          break;
        }
      } catch (e) {
        console.log('✗', e.message);
      }
    }
  }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
