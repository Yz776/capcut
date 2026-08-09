// scripts/test-keywords.js
import axios from 'axios';
const API = 'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_similar_templates';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0',
  'Referer': 'https://www.capcut.com/zh-tw/template',
  'appid': '348188', 'pf': '7', 'loc': 'sg', 'sign-ver': '1', 'app-sdk-version': '48.0.0', 'appvr': '5.8.0',
};

// Coba berbagai keyword untuk lihat mana yang return result
const keywords = ['viral', 'foryou', 'trend', 'business', 'food', 'travel', 'birthday', 'wedding', 'social media', 'animation'];
for (const kw of keywords) {
  const res = await axios.get(API, {
    params: { keyword: kw, category: kw, tabs: 'video', region_code: 'tw', language: 'zh-tw', size: 5 },
    headers: HEADERS, timeout: 15000, validateStatus: () => true,
  });
  const list = res.data?.data?.video_template_list?.video_template_list || [];
  console.log(`"${kw}" → ${list.length} results`);
}
