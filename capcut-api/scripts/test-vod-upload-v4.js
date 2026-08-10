// scripts/test-vod-upload-v4.js
//
// V4: Full VOD upload pipeline using ApplyUploadInner + CommitUploadInner.
// This is the ACTUAL flow CapCut uses for template image uploads.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';
import { signAwsV4Request } from '../src/services/vod-uploader.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

// CRC32 (IEEE 802.3 polynomial) — required by ByteDance TOS upload
// Standard table-driven implementation
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32buf(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;  // unsigned 32-bit decimal
}

function canonicalQueryString(params) {
  return Object.keys(params).sort().map(k => {
    const kEnc = encodeURIComponent(k).replace(/[^A-Za-z0-9_.~%-]/g, escape).replace(/[*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const vEnc = encodeURIComponent(params[k]).replace(/[^A-Za-z0-9_.~%-]/g, escape).replace(/[*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${kEnc}=${vEnc}`;
  }).join('&');
}

async function main() {
  console.log('=== VOD Upload V4 (Full Pipeline) ===\n');

  const api = new CapCutDirectAPI();
  await api._init();

  const fileBuf = fs.readFileSync(TEST_IMAGE);
  const fileSize = fileBuf.length;
  const fileName = path.basename(TEST_IMAGE);
  const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
  const ext = path.extname(TEST_IMAGE).toLowerCase().replace('.', '');
  const contentType = ext === 'png' ? 'image/png' : (ext === 'mp4' ? 'video/mp4' : 'image/jpeg');
  console.log(`File: ${fileName} size=${fileSize} md5=${md5.slice(0, 16)}...`);

  // === Step 1: Get /lv/v1/upload_sign token (biz=replicate) ===
  console.log('\n--- Step 1: /lv/v1/upload_sign biz=replicate ---');
  const signRes = await api._axios.post(
    'https://edit-api-sg.capcut.com/lv/v1/upload_sign',
    { key_version: 'v5', biz: 'replicate' }
  );
  if (signRes.data?.ret !== '0') {
    console.log('upload_sign failed:', signRes.data);
    process.exit(1);
  }
  const token = signRes.data.data;
  console.log(`✓ Token retrieved. space_name=${token.space_name}`);
  console.log(`  AccessKeyID: ${token.access_key_id.slice(0, 25)}...`);

  // === Step 2: ApplyUploadInner ===
  console.log('\n--- Step 2: ApplyUploadInner ---');
  const host = 'vod-ap-singapore-1.bytevcloudapi.com';
  const applyQuery = {
    Action: 'ApplyUploadInner',
    Version: '2020-11-19',
    SpaceName: token.space_name,
    UploadBytes: String(fileSize),
  };

  const applySigned = signAwsV4Request({
    method: 'GET',
    pathname: '/',
    query: applyQuery,
    headers: { host },
    body: '',
    accessKeyId: token.access_key_id,
    secretAccessKey: token.secret_access_key,
    sessionToken: token.session_token,
    region: 'i18n',
    service: 'vod',
  });
  const applyUrl = `https://${host}/?${canonicalQueryString(applyQuery)}`;
  console.log(`GET ${applyUrl.slice(0, 100)}...`);
  const applyRes = await axios.get(applyUrl, {
    headers: {
      Host: host,
      'X-Amz-Date': applySigned.amzDate,
      'x-amz-security-token': token.session_token,
      Authorization: applySigned.authorization,
    },
    timeout: 30000,
  });
  console.log(`HTTP ${applyRes.status}`);
  console.log(`Full response:`, JSON.stringify(applyRes.data, null, 2).slice(0, 4000));
  if (applyRes.data?.ResponseMetadata?.Error) {
    console.log('✗ ApplyUploadInner failed:', applyRes.data.ResponseMetadata.Error);
    process.exit(1);
  }
  fs.writeFileSync('./tmp/apply-upload-inner.json', JSON.stringify(applyRes.data, null, 2));

  const result = applyRes.data?.Result;
  if (!result) {
    console.log('✗ No Result in response');
    process.exit(1);
  }
  // Result has: UploadAddress (null for Inner), InnerUploadAddress.UploadNodes[0]
  const uploadNodes = result.InnerUploadAddress?.UploadNodes || [];
  if (uploadNodes.length === 0) {
    console.log('✗ No UploadNodes');
    process.exit(1);
  }
  const node = uploadNodes[0];
  const storeInfo = node.StoreInfos?.[0];
  const uploadHost = node.UploadHost;  // singular at node level
  const uploadHosts = node.UploadHosts || (uploadHost ? [uploadHost] : []);
  const sessionKey = node.SessionKey || result.InnerUploadAddress?.SessionKey || result.UploadAddress?.SessionKey;

  console.log(`\nUpload node info:`);
  console.log(`  Vid: ${node.Vid}`);
  console.log(`  StoreUri: ${storeInfo?.StoreUri}`);
  console.log(`  Auth: ${storeInfo?.Auth?.slice(0, 60)}...`);
  console.log(`  UploadHost: ${uploadHost}`);
  console.log(`  UploadID: ${storeInfo?.UploadID}`);
  console.log(`  SessionKey: ${sessionKey?.slice(0, 60)}...`);

  if (!uploadHost || !storeInfo) {
    console.log('✗ Missing UploadHost or StoreInfo');
    console.log('Full node:', JSON.stringify(node, null, 2).slice(0, 2000));
    process.exit(1);
  }

  // === Step 3: Upload file bytes to UploadHost/StoreUri ===
  console.log('\n--- Step 3: Upload file bytes ---');
  const uploadUrl = `https://${uploadHost}/${storeInfo.StoreUri}`;
  console.log(`POST ${uploadUrl.slice(0, 80)}...`);

  // Compute CRC32 of file (required by TOS server)
  const crc32 = crc32buf(fileBuf);
  console.log(`Content-CRC32 (decimal): ${crc32}`);
  console.log(`Content-CRC32 (hex): 0x${crc32.toString(16)}`);

  // Try multiple CRC32 header formats
  const crcVariants = [
    { label: 'decimal', value: String(crc32) },
    { label: 'hex', value: '0x' + crc32.toString(16) },
    { label: 'ignore', value: 'ignore' },
    { label: 'base64', value: Buffer.from(crc32.toString(16), 'hex').toString('base64') },
  ];

  let upRes = null;
  for (const variant of crcVariants) {
    console.log(`\n  Trying Content-CRC32=${variant.label}: "${variant.value.slice(0, 30)}"`);
    try {
      upRes = await axios.post(uploadUrl, fileBuf, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fileSize),
          Authorization: storeInfo.Auth,
          'Content-CRC32': variant.value,
          'X-Storage-U': encodeURIComponent(api.userId || ''),
        },
        timeout: 120000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });
      console.log(`  HTTP ${upRes.status}: ${JSON.stringify(upRes.data).slice(0, 200)}`);
      if (upRes.status < 400) {
        console.log(`  ✓ ${variant.label} worked!`);
        break;
      }
    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
    }
  }
  console.log(`HTTP ${upRes.status}`);
  console.log(`Response:`, JSON.stringify(upRes.data).slice(0, 500));
  if (upRes.status >= 400) {
    console.log('✗ Upload failed');
    // Continue anyway — sometimes the response is just metadata
  } else {
    console.log('✓ Upload succeeded');
  }
  fs.writeFileSync('./tmp/upload-bytes-response.json', JSON.stringify({ status: upRes.status, data: upRes.data }, null, 2));

  // === Step 4: CommitUploadInner ===
  // Wait a few seconds for upload to propagate
  console.log('\n--- Waiting 5s for upload to propagate ---');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n--- Step 4: CommitUploadInner (POST with body) ---');
  // Per bundle-019.js offset 363501:
  //   POST CommitUploadInner with body: {SessionKey, Functions: []}
  //   Content-Type: application/json
  const commitBody = JSON.stringify({
    SessionKey: sessionKey,
    Functions: [],
  });
  const commitQueryGet = {
    Action: 'CommitUploadInner',
    Version: '2020-11-19',
    SpaceName: token.space_name,
  };
  const commitSigned = signAwsV4Request({
    method: 'POST',
    pathname: '/',
    query: commitQueryGet,
    headers: { host, 'content-type': 'application/json' },
    body: commitBody,
    accessKeyId: token.access_key_id,
    secretAccessKey: token.secret_access_key,
    sessionToken: token.session_token,
    region: 'i18n',
    service: 'vod',
  });
  const commitUrl = `https://${host}/?${canonicalQueryString(commitQueryGet)}`;
  console.log(`POST ${commitUrl.slice(0, 100)}...`);
  console.log(`Body: ${commitBody.slice(0, 100)}...`);
  let commitRes = await axios.post(commitUrl, commitBody, {
    headers: {
      Host: host,
      'Content-Type': 'application/json',
      'X-Amz-Date': commitSigned.amzDate,
      'X-Amz-Content-Sha256': commitSigned.headers['X-Amz-Content-Sha256'],
      'x-amz-security-token': token.session_token,
      Authorization: commitSigned.authorization,
    },
    timeout: 30000,
    validateStatus: () => true,
  });
  console.log(`HTTP ${commitRes.status}`);
  console.log(`Response:`, JSON.stringify(commitRes.data, null, 2).slice(0, 2000));
  fs.writeFileSync('./tmp/commit-upload-inner.json', JSON.stringify(commitRes.data, null, 2));

  // Also try GET with SessionKey in query (older API)
  if (commitRes.data?.ResponseMetadata?.Error) {
    console.log('\n--- Step 4b: Try GET with SessionKey in query ---');
    const commitQuery2 = {
      Action: 'CommitUploadInner',
      Version: '2020-11-19',
      SpaceName: token.space_name,
      SessionKey: sessionKey,
    };
    const commitSigned2 = signAwsV4Request({
      method: 'GET',
      pathname: '/',
      query: commitQuery2,
      headers: { host },
      body: '',
      accessKeyId: token.access_key_id,
      secretAccessKey: token.secret_access_key,
      sessionToken: token.session_token,
      region: 'i18n',
      service: 'vod',
    });
    const commitUrl2 = `https://${host}/?${canonicalQueryString(commitQuery2)}`;
    const commitRes2 = await axios.get(commitUrl2, {
      headers: {
        Host: host,
        'X-Amz-Date': commitSigned2.amzDate,
        'x-amz-security-token': token.session_token,
        Authorization: commitSigned2.authorization,
      },
      timeout: 30000,
      validateStatus: () => true,
    });
    console.log(`HTTP ${commitRes2.status}`);
    console.log(`Response:`, JSON.stringify(commitRes2.data, null, 2).slice(0, 2000));
    if (!commitRes2.data?.ResponseMetadata?.Error) commitRes = commitRes2;
  }

  if (commitRes.data?.ResponseMetadata?.Error) {
    console.log('✗ CommitUploadInner failed');
    return;
  }

  const commitResult = commitRes.data?.Result || {};
  const results = commitResult.Results || [];
  console.log(`\n=== Upload complete! ===`);
  console.log(`Results: ${results.length}`);
  if (results.length > 0) {
    const r = results[0];
    console.log(`  Vid: ${r.Vid}`);
    console.log(`  MainUrl: ${r.MainUrl}`);
    console.log(`  BackupUrls: ${JSON.stringify(r.BackupUrls || [])}`);
    console.log(`  Source: ${r.Source}`);
    console.log(`  Md5: ${r.Md5}`);
    fs.writeFileSync('./tmp/upload-success-v4.json', JSON.stringify({
      token: { space_name: token.space_name },
      applyResult: { Vid: node.Vid, StoreUri: storeInfo.StoreUri, UploadHost: uploadHost, SessionKey: sessionKey },
      commitResult: r,
      file: { name: fileName, size: fileSize, md5, contentType },
    }, null, 2));
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
