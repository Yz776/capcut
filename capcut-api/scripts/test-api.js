import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

try {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Intercept XHR/fetch calls
  const apiCalls = [];
  page.on('response', async (res) => {
    const url = res.url();
    if (/api|graphql|aweme|template/i.test(url) && res.request().resourceType() === 'xhr') {
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json')) {
          const text = await res.text();
          apiCalls.push({ url, status: res.status(), size: text.length, snippet: text.slice(0, 300) });
        }
      } catch (_) {}
    }
  });

  console.log('=== Loading template detail page ===');
  await page.goto('https://www.capcut.com/zh-tw/template-detail/foryou-trend-Viral/7492444922599968053', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));

  console.log(`\n=== API calls intercepted: ${apiCalls.length} ===`);
  apiCalls.forEach((c, i) => {
    console.log(`\n[${i}] ${c.status} ${c.url.slice(0, 120)}`);
    console.log(`     Size: ${c.size}b | Snippet: ${c.snippet.slice(0, 200).replace(/\n/g, ' ')}`);
  });

  // Coba test cURL ke endpoint CapCut public API (kalau ada)
  console.log('\n=== Test direct API access ===');
  const endpoints = [
    'https://www.capcut.com/api/v1/template/info?template_id=7492444922599968053',
    'https://www.capcut.com/api/template/detail/7492444922599968053',
    'https://www.capcut.com/api/v1/template/detail?aid=3667&template_id=7492444922599968053',
  ];
  for (const ep of endpoints) {
    const res = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        return { status: r.status, body: (await r.text()).slice(0, 200) };
      } catch (e) {
        return { error: e.message };
      }
    }, ep);
    console.log(`${res.status || 'ERR'} ${ep}`);
    console.log(`     ${(res.body || res.error || '').slice(0, 150)}`);
  }

} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  await browser.close();
}
