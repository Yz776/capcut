import axios from 'axios';

const BASE = 'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_similar_templates';

// Coba berbagai parameter untuk dapat list template tanpa template_id anchor
const tests = [
  // Tanpa template_id, hanya keyword
  { name: 'keyword only', params: { keyword: 'viral', tabs: 'video', region_code: 'tw', language: 'zh-tw', size: 10 } },
  // Category
  { name: 'category=social', params: { keyword: 'social', category: 'social', tabs: 'video', region_code: 'tw', language: 'zh-tw', size: 10 } },
  // Empty keyword
  { name: 'empty keyword', params: { keyword: '', tabs: 'video', region_code: 'tw', language: 'zh-tw', size: 10 } },
  // Try alternate endpoint: get_hot_templates
  { name: 'different endpoint', url: 'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_hot_templates', params: { tabs: 'video', region_code: 'tw', language: 'zh-tw', size: 10 } },
];

for (const t of tests) {
  const url = t.url || BASE;
  console.log(`\n=== ${t.name} ===`);
  console.log(`URL: ${url}`);
  console.log(`Params: ${JSON.stringify(t.params)}`);
  try {
    const res = await axios.get(url, {
      params: t.params,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Referer': 'https://www.capcut.com/zh-tw/template',
        'appid': '348188',
        'pf': '7',
        'loc': 'sg',
        'sign-ver': '1',
        'app-sdk-version': '48.0.0',
        'appvr': '5.8.0',
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    console.log(`Status: ${res.status}`);
    const data = res.data;
    if (data?.data?.video_template_list?.video_template_list) {
      const list = data.data.video_template_list.video_template_list;
      console.log(`✓ Got ${list.length} templates`);
      list.slice(0, 3).forEach((t, i) => {
        console.log(`  [${i}] id=${t.template_id} | dur=${t.template_duration}s | use=${t.use_count} | ${t.title?.trim().slice(0, 40)}`);
        console.log(`      url=${t.template_url?.slice(0, 100)}`);
        console.log(`      video=${t.video_url?.slice(0, 100)}`);
      });
    } else {
      console.log(`Response snippet: ${JSON.stringify(data).slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`ERR: ${e.message}`);
  }
}
