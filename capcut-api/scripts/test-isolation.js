import http from 'node:http';
import puppeteer from 'puppeteer';

process.on('exit', (code) => console.log('[process] exit code:', code));
process.on('SIGTERM', () => console.log('[process] SIGTERM'));
process.on('SIGINT', () => console.log('[process] SIGINT'));
process.on('uncaughtException', (e) => console.log('[process] uncaughtException:', e.message, e.stack));
process.on('unhandledRejection', (e) => console.log('[process] unhandledRejection:', e?.message || e));

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});

server.listen(3099, () => {
  console.log('[server] listening on 3099');
  
  // Test: launch + close puppeteer
  console.log('[test] launching browser');
  puppeteer.launch({
    headless: 'new',
    userDataDir: '/tmp/test-profile-x',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  }).then(async browser => {
    console.log('[test] browser launched');
    const page = await browser.newPage();
    await page.goto('https://www.capcut.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[test] navigated, url=', page.url());
    await page.screenshot({ path: '/tmp/test.png' });
    console.log('[test] screenshot saved');
    
    console.log('[test] closing browser');
    await browser.close();
    console.log('[test] browser closed');
    
    console.log('[test] server still listening?', server.listening);
  }).catch(e => console.log('[test] error:', e.message));
});
