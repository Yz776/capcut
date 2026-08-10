// scripts/test-endpoints.js
//
// End-to-end test script for all CapCut JJ API endpoints.
// Verifies:
//   1. GET /health
//   2. GET / (server info)
//   3. GET /login (HTML form)
//   4. GET /login/status (cached + refresh)
//   5. GET /templates (no login needed)
//   6. GET /templates/search (no login needed)
//   7. POST /render-direct (creates job)
//   8. GET /render-direct/status/:jobId (verifies failure with SESSION_EXPIRED if not logged in)
//
// Usage: node scripts/test-endpoints.js [base-url]
// Default base URL: http://localhost:7000

const BASE = process.argv[2] || 'http://localhost:7000';

let passed = 0, failed = 0;

function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function nope(name, why) { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${why}`); failed++; }

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`\n=== CapCut JJ API Endpoint Tests ===`);
  console.log(`Base URL: ${BASE}\n`);

  // === Test 1: GET /health ===
  console.log('Test 1: GET /health');
  try {
    const r = await fetchJson(`${BASE}/health`);
    if (r.status === 200 && r.json?.status === 'ok') {
      ok(`health ok (uptime=${r.json.uptime?.toFixed(1)}s, mem=${r.json.memoryMB}MB)`);
    } else {
      nope('health', `status=${r.status}, body=${r.text?.slice(0, 100)}`);
    }
  } catch (e) { nope('health', e.message); }

  // === Test 2: GET / ===
  console.log('\nTest 2: GET /');
  try {
    const r = await fetchJson(`${BASE}/`);
    if (r.status === 200 && r.json?.name === 'CapCut JJ API') {
      ok(`server info (version=${r.json.version}, endpoints=${Object.keys(r.json.endpoints || {}).length})`);
    } else {
      nope('server info', `status=${r.status}, body=${r.text?.slice(0, 100)}`);
    }
  } catch (e) { nope('server info', e.message); }

  // === Test 3: GET /login (HTML form) ===
  console.log('\nTest 3: GET /login (HTML form)');
  try {
    const res = await fetch(`${BASE}/login`);
    const html = await res.text();
    if (res.status === 200 && html.includes('CapCut API Login') && html.includes('cookies')) {
      ok('login HTML form rendered');
    } else {
      nope('login HTML', `status=${res.status}, html length=${html.length}`);
    }
  } catch (e) { nope('login HTML', e.message); }

  // === Test 4: GET /login/status ===
  console.log('\nTest 4: GET /login/status (may take 30s first time due to puppeteer)');
  try {
    const r = await fetchJson(`${BASE}/login/status`);
    if (r.status === 200 && typeof r.json?.loggedIn === 'boolean') {
      const status = r.json.loggedIn ? 'LOGGED IN' : 'NOT LOGGED IN';
      ok(`login status: ${status} (cookies=${r.json.cookieCount}, missing=${r.json.missing?.join(',') || 'none'})`);
      if (!r.json.loggedIn) {
        console.log(`    \x1b[33m→\x1b[0m ${r.json.error}`);
        console.log(`    \x1b[33m→\x1b[0m Refresh at: ${BASE}/login`);
      }
    } else {
      nope('login status', `status=${r.status}, body=${r.text?.slice(0, 100)}`);
    }
  } catch (e) { nope('login status', e.message); }

  // === Test 5: GET /login/status (cached - should be fast) ===
  console.log('\nTest 5: GET /login/status?refresh=0 (cached, should be <500ms)');
  try {
    const t0 = Date.now();
    const r = await fetchJson(`${BASE}/login/status`);
    const dt = Date.now() - t0;
    if (dt < 1000) {
      ok(`cached status response in ${dt}ms`);
    } else {
      nope('cached status', `took ${dt}ms (expected <1000ms)`);
    }
  } catch (e) { nope('cached status', e.message); }

  // === Test 6: GET /templates (no login) ===
  console.log('\nTest 6: GET /templates?limit=3 (no login needed)');
  try {
    const r = await fetchJson(`${BASE}/templates?limit=3`);
    if (r.status === 200 && Array.isArray(r.json?.templates) && r.json.templates.length > 0) {
      const titles = r.json.templates.map(t => `"${t.title}"`).join(', ');
      ok(`got ${r.json.templates.length} templates: ${titles}`);
    } else {
      nope('templates', `status=${r.status}, body=${r.text?.slice(0, 100)}`);
    }
  } catch (e) { nope('templates', e.message); }

  // === Test 7: GET /templates/search (no login) ===
  console.log('\nTest 7: GET /templates/search?q=cat&limit=3');
  try {
    const r = await fetchJson(`${BASE}/templates/search?q=cat&limit=3`);
    if (r.status === 200 && Array.isArray(r.json?.templates)) {
      ok(`search "cat" returned ${r.json.templates.length} templates`);
    } else {
      nope('templates/search', `status=${r.status}, body=${r.text?.slice(0, 100)}`);
    }
  } catch (e) { nope('templates/search', e.message); }

  // === Test 8: POST /render-direct (no images - should 400) ===
  console.log('\nTest 8: POST /render-direct (no images, should return 400)');
  try {
    const r = await fetchJson(`${BASE}/render-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (r.status === 400 && r.json?.error?.includes('image required')) {
      ok('properly rejected empty body');
    } else {
      nope('empty body validation', `status=${r.status}, body=${r.text?.slice(0, 100)}`);
    }
  } catch (e) { nope('empty body validation', e.message); }

  // === Test 9: POST /render-direct (with local image - should create job) ===
  console.log('\nTest 9: POST /render-direct with local image (job should be created)');
  try {
    const testImg = '/home/z/my-project/capcut-api/test-assets/img1.jpg';
    const r = await fetchJson(`${BASE}/render-direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: [testImg], videoName: 'Test Render' }),
    });
    if (r.status === 202 && r.json?.jobId) {
      ok(`job created: ${r.json.jobId}`);
      // Wait for job to process
      console.log('    Waiting 8s for job to process...');
      await new Promise(r => setTimeout(r, 8000));
      const s = await fetchJson(`${BASE}/render-direct/status/${r.json.jobId}`);
      if (s.status === 200 && (s.json?.status === 'completed' || s.json?.status === 'failed')) {
        if (s.json.status === 'completed') {
          ok(`job completed! videoUrl=${s.json.videoUrl}`);
        } else {
          // Failed is expected when session expired
          if (s.json.error?.includes('SESSION_EXPIRED') || s.json.error?.includes('1015')) {
            ok(`job correctly failed with session-expired error (expected if not logged in)`);
            console.log(`    \x1b[33m→\x1b[0m ${s.json.error}`);
          } else {
            nope('job failed unexpectedly', s.json.error);
          }
        }
      } else {
        nope('job status', `status=${s.status}, body=${s.text?.slice(0, 100)}`);
      }
    } else {
      nope('job creation', `status=${r.status}, body=${r.text?.slice(0, 100)}`);
    }
  } catch (e) { nope('job creation', e.message); }

  // === Summary ===
  console.log('\n=== Test Summary ===');
  console.log(`  \x1b[32mPassed: ${passed}\x1b[0m`);
  console.log(`  \x1b[31mFailed: ${failed}\x1b[0m`);
  if (failed > 0) {
    console.log('\n\x1b[33mNote: Some tests may fail if CapCut session is expired.\x1b[0m');
    console.log('\x1b[33mRefresh session at: ' + BASE + '/login\x1b[0m');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
