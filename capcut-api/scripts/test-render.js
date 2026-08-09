// scripts/test-render.js
//
// End-to-end test: submit render job → poll status → download video → save lokal.
//
// Prerequisite:
//   1. `npm run login:manual` sudah dijalankan & session tersimpan di .capcut-profile/
//   2. API server jalan: `npm start` (default port 7000)
//
// Usage:
//   node scripts/test-render.js [templateId] [imageUrl1] [imageUrl2]
//
// Default (kalau gak ada argumen): pakai template CapCut populer + 2 gambar placeholder.
//
// Examples:
//   node scripts/test-render.js
//   node scripts/test-render.js 7598329412446375173 \
//     https://cdn.nekohime.site/file/m8dh80bd.jpg \
//     https://cdn.nekohime.site/file/ar7dy0f6.jpg

import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const BASE = process.env.PUBLIC_BASE_URL || 'http://localhost:7000';

// Default args (kalau gak ada CLI args)
const DEFAULT_TEMPLATE_ID = '7598329412446375173';
const DEFAULT_IMAGE_URLS = [
  'https://cdn.nekohime.site/file/m8dh80bd.jpg',
  'https://cdn.nekohime.site/file/ar7dy0f6.jpg',
];

const cliArgs = process.argv.slice(2);
const template = cliArgs[0] || DEFAULT_TEMPLATE_ID;
const imageUrls = cliArgs.slice(1).length >= 2 ? cliArgs.slice(1) : DEFAULT_IMAGE_URLS;

// ===== Helpers =====
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function checkServerUp() {
  try {
    const res = await axios.get(`${BASE}/health`, { timeout: 5000 });
    if (res.data?.status === 'ok') return true;
  } catch (_) {}
  return false;
}

// ===== Main =====
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  CapCut Render — End-to-End Test');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  API base   : ${BASE}`);
  console.log(`  Template   : ${template}`);
  console.log(`  Images     : ${imageUrls.length} URL(s)`);
  imageUrls.forEach((u, i) => console.log(`    [${i + 1}] ${u}`));
  console.log('───────────────────────────────────────────────────────────');
  console.log('');

  // Step 1: cek server up
  log('Step 1: Cek API server...');
  if (!(await checkServerUp())) {
    console.error(`✗ Server tidak responsif di ${BASE}.`);
    console.error(`  Pastikan 'npm start' sudah dijalankan di terminal lain.`);
    process.exit(1);
  }
  log('✓ Server up');

  // Step 2: submit render
  log('Step 2: Submit render job...');
  let jobId;
  try {
    const res = await axios.post(`${BASE}/render`, {
      template,
      imageUrls,
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    jobId = res.data.jobId;
    log(`✓ Job submitted: ${jobId}`);
    log(`  statusUrl : ${BASE}${res.data.statusUrl}`);
  } catch (e) {
    console.error(`✗ Submit gagal: ${e.message}`);
    if (e.response?.data) console.error('  Response:', JSON.stringify(e.response.data, null, 2));
    process.exit(1);
  }

  // Step 3: poll status
  log('Step 3: Polling status (ini bisa 2-5 menit)...');
  const start = Date.now();
  let lastProgress = -1;
  let lastMessage = '';
  let finalStatus = null;

  while (true) {
    let job;
    try {
      const res = await axios.get(`${BASE}/render/status/${jobId}`, { timeout: 10000 });
      job = res.data;
    } catch (e) {
      log(`  (poll error: ${e.message}, retry...)`);
      await sleep(5000);
      continue;
    }

    // Print kalau progress/message berubah
    if (job.progress !== lastProgress || job.message !== lastMessage) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      log(`  [${elapsed}s] ${job.progress}% — ${job.message || '(no message)'}`);
      lastProgress = job.progress;
      lastMessage = job.message;
    }

    if (job.status === 'completed' || job.status === 'failed') {
      finalStatus = job;
      break;
    }
    await sleep(5000);
  }

  console.log('');
  if (finalStatus.status === 'failed') {
    console.error('═══════════════════════════════════════════════════════════');
    console.error('  ✗ RENDER FAILED');
    console.error('═══════════════════════════════════════════════════════════');
    console.error(`  Error: ${finalStatus.error}`);
    console.error('');
    console.error('  Troubleshooting:');
    if (finalStatus.error?.includes('session') || finalStatus.error?.includes('login')) {
      console.error('  → Session CapCut expired. Jalankan: npm run login:manual');
    } else if (finalStatus.error?.includes('selector') || finalStatus.error?.includes('not found')) {
      console.error('  → UI CapCut berubah. Jalankan: node scripts/inspect-editor.js');
    } else if (finalStatus.error?.includes('timeout')) {
      console.error('  → Render timeout. Tingkatkan RENDER_TIMEOUT di .env');
    }
    process.exit(1);
  }

  // Step 4: download video
  log('Step 4: Downloading rendered video...');
  const outFile = path.join(projectRoot, 'test-output.mp4');
  try {
    const res = await axios.get(`${BASE}/render/download/${jobId}`, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      // follow redirect (axios default sudah true)
    });
    fs.writeFileSync(outFile, Buffer.from(res.data));
    const sizeMB = (res.data.length / 1024 / 1024).toFixed(2);
    log(`✓ Video saved: ${outFile} (${sizeMB} MB)`);
  } catch (e) {
    console.error(`✗ Download gagal: ${e.message}`);
    if (e.response?.data) {
      const txt = e.response.data.toString().slice(0, 500);
      console.error('  Response body:', txt);
    }
    process.exit(1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✓ END-TO-END TEST PASSED');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Job ID    : ${jobId}`);
  console.log(`  Total time: ${Math.round((Date.now() - start) / 1000)}s`);
  console.log(`  Output    : ${outFile}`);
  console.log(`  Video URL : ${finalStatus.videoUrl}`);
  console.log('');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
