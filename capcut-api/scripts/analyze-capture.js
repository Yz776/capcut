#!/usr/bin/env node
// Analyze captured API traffic from CapCut editor session.
// Reads tmp/api-capture-*.jsonl and prints a human-readable summary
// of all endpoints, methods, and bodies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const tmpDir = path.join(projectRoot, 'tmp');

const file = process.argv[2];
if (!file) {
  // Use latest capture
  const files = fs.readdirSync(tmpDir)
    .filter(f => f.startsWith('api-capture-') && f.endsWith('.jsonl'))
    .sort();
  if (!files.length) {
    console.error('No capture file found in tmp/');
    process.exit(1);
  }
  const latest = path.join(tmpDir, files[files.length - 1]);
  console.error(`[analyze] Using latest: ${latest}`);
  analyze(latest);
} else {
  analyze(path.isAbsolute(file) ? file : path.resolve(file));
}

function analyze(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  console.log(`\n=== ${filePath} ===`);
  console.log(`Total entries: ${lines.length}\n`);

  const requests = [];
  const responses = [];
  const consoles = [];
  const errors = [];

  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.kind === 'request') requests.push(e);
      else if (e.kind === 'response') responses.push(e);
      else if (e.kind === 'console') consoles.push(e);
      else if (e.kind === 'error') errors.push(e);
    } catch {}
  }

  console.log(`Requests: ${requests.length}`);
  console.log(`Responses: ${responses.length}`);
  console.log(`Console msgs: ${consoles.length}`);
  console.log(`Errors: ${errors.length}\n`);

  // Group requests by URL path (without query string)
  const byPath = new Map();
  for (const r of requests) {
    let pathOnly;
    try {
      const u = new URL(r.url);
      pathOnly = u.hostname + u.pathname;
    } catch { pathOnly = r.url; }
    if (!byPath.has(pathOnly)) byPath.set(pathOnly, []);
    byPath.get(pathOnly).push(r);
  }

  console.log('=== ALL ENDPOINTS (sorted by frequency) ===\n');
  const sorted = [...byPath.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [p, reqs] of sorted) {
    const methods = [...new Set(reqs.map(r => r.method))];
    console.log(`  [${methods.join(',')}] ${p}  ×${reqs.length}`);
  }

  console.log('\n=== POST/PUT/PATCH REQUESTS (potential render submit) ===\n');
  const writes = requests.filter(r => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method));
  for (const r of writes) {
    console.log(`\n--- ${r.method} ${r.url} (seq ${r.seq}) ---`);
    if (r.postData) {
      const preview = r.postData.length > 1500 ? r.postData.slice(0, 1500) + '...' : r.postData;
      console.log('Body:');
      console.log(preview);
    } else {
      console.log('(no body)');
    }
  }

  console.log('\n=== RENDER-API CANDIDATES (POST + render-related path) ===\n');
  const renderCandidates = requests.filter(r =>
    ['POST', 'PUT'].includes(r.method) &&
    /render|export|compile|draft|publish|create|task|job|project|cutout|vedit|mcp|lapi|luckycat/i.test(r.url)
  );
  for (const r of renderCandidates) {
    console.log(`\n>>> ${r.method} ${r.url}`);
    if (r.postData) {
      const preview = r.postData.length > 2000 ? r.postData.slice(0, 2000) + '...' : r.postData;
      console.log('Body:', preview);
    }
    // Find matching response
    const resp = responses.find(rp => rp.url === r.url && Math.abs(rp.seq - r.seq) <= 5);
    if (resp) {
      console.log(`Response: HTTP ${resp.status} ${resp.contentType?.slice(0, 60)}`);
      if (resp.body) {
        const preview = resp.body.length > 800 ? resp.body.slice(0, 800) + '...' : resp.body;
        console.log('  ', preview);
      }
    }
  }

  console.log('\n=== GET REQUESTS to API-like paths ===\n');
  const apiGets = requests.filter(r =>
    r.method === 'GET' &&
    /\/api\/|\/luckycat\/|\/lapi\/|\/mcp\/|render|export|draft|task|job|project|publish|cutout|vedit/i.test(r.url)
  );
  for (const r of apiGets) {
    console.log(`GET ${r.url}`);
  }

  console.log('\n=== RESPONSES with interesting status codes (4xx/5xx) ===\n');
  for (const r of responses) {
    if (r.status >= 400) {
      console.log(`HTTP ${r.status} ${r.method} ${r.url}`);
      if (r.body) console.log('  ', r.body.slice(0, 500));
    }
  }

  console.log('\n=== CONSOLE ERRORS ===\n');
  for (const c of consoles.filter(c => c.type === 'error').slice(0, 20)) {
    console.log(`  ${c.text}`);
  }

  console.log('\n=== FATAL ERRORS ===\n');
  for (const e of errors) {
    console.log(`  ${e.message}`);
  }
}
