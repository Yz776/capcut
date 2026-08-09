// Connect ke browser yang sudah running via CDP, click "Continue with email",
// inspect form yang muncul.
import puppeteer from 'puppeteer';
import fs from 'node:fs';

// Connect ke existing browser via CDP endpoint
const browser = await puppeteer.connect({
  browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser',
  defaultViewport: null,
});

const pages = await browser.pages();
const page = pages[0];
console.log('Current URL:', page.url());

// Click "Continue with email"
console.log('Looking for email option...');
const emailBtn = await page.$('div:has-text("Continue with email"), button:has-text("email"), [class*="email" i]');
if (emailBtn) {
  console.log('Found email button, clicking...');
  await emailBtn.click();
  await new Promise(r => setTimeout(r, 3000));
  console.log('After click, URL:', page.url());
}

// Screenshot form
await page.screenshot({ path: '/home/z/my-project/capcut-api/tmp/email-form.png', fullPage: false });

// Cek fields yang muncul
const formFields = await page.$$eval('input', els => els.map(el => ({
  type: el.type,
  name: el.name,
  placeholder: el.placeholder,
  class: (el.className || '').slice(0, 80),
})));
console.log('Form fields:', JSON.stringify(formFields, null, 2));

// Cek apakah ada captcha / verification
const pageText = await page.evaluate(() => document.body?.innerText || '');
console.log('\n=== Page text snippet (first 500 chars) ===');
console.log(pageText.slice(0, 500));

const hasCaptcha = /captcha|verify|robot|滑块|拼图/i.test(pageText);
console.log('\nCaptcha detected:', hasCaptcha);

// Disconnect (don't close browser)
browser.disconnect();
