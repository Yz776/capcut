// scripts/smoke-test.js
// Run: node scripts/smoke-test.js
// Cek apakah API bisa start dengan benar tanpa crash.
// Tidak menjalankan render CapCut sebenarnya (butuh credentials + browser).

import axios from 'axios';

const BASE = process.env.PUBLIC_BASE_URL || 'http://localhost:7000';

async function smokeTest() {
  console.log(`\n=== Smoke Test CapCut JJ API @ ${BASE} ===\n`);

  const tests = [
    { name: 'GET /', method: 'GET', url: '/' },
    { name: 'GET /health', method: 'GET', url: '/health' },
    { name: 'GET /status/nonexistent (expect 404)', method: 'GET', url: '/status/abc', expectStatus: 404 },
    { name: 'GET /templates (might fail if no creds)', method: 'GET', url: '/templates?limit=5' },
  ];

  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      const res = await axios({ method: t.method, url: BASE + t.url, timeout: 60000, validateStatus: () => true });
      const ok = !t.expectStatus || res.status === t.expectStatus;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name} -> ${res.status}`);
      if (!ok) {
        console.log(`       Expected ${t.expectStatus}, got ${res.status}`);
        console.log(`       Body: ${JSON.stringify(res.data).slice(0, 200)}`);
        fail++;
      } else {
        pass++;
      }
    } catch (e) {
      console.log(`FAIL  ${t.name} -> ${e.message}`);
      fail++;
    }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

smokeTest();
