import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Cari FULL URL get_similar_templates
  let fullUrl = null;
  page.on('request', (req) => {
    if (req.url().includes('get_similar_templates') || req.url().includes('template_id')) {
      if (!fullUrl) {
        fullUrl = req.url();
        console.log('FULL URL:', fullUrl);
        console.log('Headers:', JSON.stringify(req.headers(), null, 2).slice(0, 500));
      }
    }
  });

  await page.goto('https://www.capcut.com/zh-tw/template-detail/foryou-trend-Viral/7492444922599968053', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));

  if (fullUrl) {
    // Test direct call dengan axios
    console.log('\n=== Test direct axios call to similar templates API ===');
    const axios = (await import('axios')).default;
    try {
      const res = await axios.get(fullUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
          'Referer': 'https://www.capcut.com/zh-tw/template-detail/foryou-trend-Viral/7492444922599968053',
        },
        timeout: 15000,
      });
      console.log('Status:', res.status);
      const list = res.data?.data?.video_template_list?.video_template_list || [];
      console.log(`Got ${list.length} templates`);
      if (list[0]) {
        console.log('\nFirst template fields:', Object.keys(list[0]));
        console.log('\nFirst template sample:');
        const t = list[0];
        console.log(JSON.stringify({
          template_id: t.template_id,
          title: t.title,
          duration: t.duration,
          cover_url: t.cover_url?.slice(0, 80),
          author: t.author,
          use_count: t.use_count || t.usecnt || t.play_count,
          raw_keys: Object.keys(t),
        }, null, 2));
      }
    } catch (e) {
      console.error('Axios failed:', e.message);
    }
  } else {
    console.log('No similar templates URL captured');
  }

  // Sekarang cari endpoint untuk single template info
  console.log('\n=== Test endpoints for single template info ===');
  const endpoints = [
    'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_template_detail?template_id=7492444922599968053',
    'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/template_detail?template_id=7492444922599968053',
    'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_template_info?template_id=7492444922599968053',
  ];
  const axios = (await import('axios')).default;
  for (const ep of endpoints) {
    try {
      const res = await axios.get(ep, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.capcut.com/' }, timeout: 10000, validateStatus: () => true });
      console.log(`\n${res.status} ${ep.slice(0, 100)}`);
      console.log(`  ${(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).slice(0, 300)}`);
    } catch (e) {
      console.log(`ERR ${ep.slice(0, 80)}: ${e.message}`);
    }
  }

} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await browser.close();
}
