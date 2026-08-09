import axios from 'axios';
import puppeteer from 'puppeteer';

const API = 'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_similar_templates';

const res = await axios.get(API, {
  params: { keyword: 'social', category: 'social', tabs: 'video', region_code: 'tw', language: 'zh-tw', size: 3 },
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0',
    'Referer': 'https://www.capcut.com/zh-tw/template',
    'appid': '348188', 'pf': '7', 'loc': 'sg', 'sign-ver': '1', 'app-sdk-version': '48.0.0', 'appvr': '5.8.0',
  },
  timeout: 15000,
});

const list = res.data?.data?.video_template_list?.video_template_list || [];
console.log(`Got ${list.length} templates\n`);

// Cek structured_data salah satu template (biasanya berisi info slot/edit zone)
const t = list[0];
console.log('=== Full template object keys ===');
console.log(Object.keys(t));
console.log('\n=== Title:', t.title);
console.log('Duration:', t.template_duration, '(assume ms =', t.template_duration / 1000, 's)');
console.log('Use count:', t.use_count);
console.log('Video ratio:', t.video_ratio);
console.log('Cover dims:', t.cover_width, 'x', t.cover_height);

console.log('\n=== structured_data (parsed) ===');
try {
  const sd = typeof t.structured_data === 'string' ? JSON.parse(t.structured_data) : t.structured_data;
  console.log(JSON.stringify(sd, null, 2).slice(0, 2000));
} catch (e) {
  console.log('Raw:', String(t.structured_data).slice(0, 500));
}

// Test: apakah URL tanpa slug bisa dipakai?
console.log('\n=== Test URL without slug ===');
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
try {
  const page = await browser.newPage();
  const testUrl = `https://www.capcut.com/zh-tw/template-detail/x/${t.template_id}`;
  console.log('Testing URL:', testUrl);
  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('Final URL:', page.url());
  console.log('Title:', await page.title());
  const hasBtn = await page.$('.btn-use-template');
  console.log('Has Use Template button:', !!hasBtn);
  if (hasBtn) {
    const href = await page.$eval('.btn-use-template', el => el.getAttribute('href'));
    console.log('Button href:', href?.slice(0, 200));
  }
} catch (e) {
  console.error('URL test failed:', e.message);
} finally {
  await browser.close();
}
