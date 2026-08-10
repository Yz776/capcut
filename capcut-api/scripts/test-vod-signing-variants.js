// scripts/test-vod-signing-variants.js
//
// Diagnose VOD/ImageX signing issues by trying multiple variants:
//   1. Standard Volc SignV4 with secret as UTF-8 string
//   2. Volc SignV4 with secret as base64-decoded bytes
//   3. With/without X-Tt-PSM header
//   4. Different service names ('imagex', 'vod', 'capcut')
//   5. Different X-Date formats

import crypto from 'node:crypto';
import axios from 'axios';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
}
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}
function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}
function uriEncode(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || ch === '-' || ch === '.' || ch === '_' || ch === '~') {
      out += ch;
    } else {
      const buf = Buffer.from(ch, 'utf8');
      for (const b of buf) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}
function canonicalQueryString(params) {
  return Object.keys(params).sort().map(k => `${uriEncode(k)}=${uriEncode(params[k])}`).join('&');
}

function trySign({ secretKey, secretIsBase64, accessKeyId, sessionToken, region, service, method, path, query, host, body, extraHeaders }) {
  const now = new Date();
  const shortDate = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const longDate = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

  // Resolve secret key bytes
  let secretBytes;
  if (secretIsBase64) {
    secretBytes = Buffer.from(secretKey, 'base64');
  } else {
    secretBytes = Buffer.from(secretKey, 'utf8');
  }

  const headers = {
    host,
    'x-content-sha256': sha256Hex(body),
    'x-date': longDate,
    ...extraHeaders,
  };
  if (sessionToken) headers['x-security-token'] = sessionToken;

  // Canonical headers
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase().trim(), String(v).trim()])
    .sort(([a], [b]) => a.localeCompare(b));
  const canonicalH = entries.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedH = entries.map(([k]) => k).join(';');

  const cq = canonicalQueryString(query);
  const payloadHash = sha256Hex(body);
  const canonicalRequest = `${method}\n${path}\n${cq}\n${canonicalH}\n${signedH}\n${payloadHash}`;

  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = `HMAC-SHA256\n${longDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;

  const kDate = hmacSha256(secretBytes, shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'request');
  const signature = hmacSha256Hex(kSigning, stringToSign);

  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedH}, Signature=${signature}`;

  return { headers, authorization, longDate, signature, canonicalRequest, stringToSign };
}

async function main() {
  console.log('=== VOD Signing Variants Test ===\n');
  const api = new CapCutDirectAPI();
  await api._init();

  // Get fresh STS
  const stsRes = await api._axios.post(
    'https://edit-api-sg.capcut.com/lv/v1/asset/prepare_upload_cloud',
    { space_id: '0', workspace_id: api.workspaceId, is_web_user: true }
  );
  if (stsRes.data?.ret !== '0') {
    console.log('STS failed:', stsRes.data);
    process.exit(1);
  }
  const sts = stsRes.data.data;
  console.log(`STS: access_key_id=${sts.security_token.access_key_id.slice(0, 25)}...`);
  console.log(`     secret_access_key=${sts.security_token.secret_access_key.slice(0, 25)}...`);
  console.log(`     session_token=${sts.security_token.session_token.slice(0, 30)}...`);
  console.log(`     upload_domain=${sts.upload_domain}`);
  console.log(`     service_id=${sts.service_id}\n`);

  const fileSize = 61060; // small test
  const variants = [
    { name: '1. UTF-8 secret, service=imagex, region=ap-singapore-1', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'imagex' } },
    { name: '2. UTF-8 secret, service=vod, region=ap-singapore-1', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'vod' } },
    { name: '3. Base64-decoded secret, service=imagex', opts: { secretIsBase64: true, region: 'ap-singapore-1', service: 'imagex' } },
    { name: '4. Base64-decoded secret, service=vod', opts: { secretIsBase64: true, region: 'ap-singapore-1', service: 'vod' } },
    { name: '5. UTF-8 secret, service=imagex, region=cn-north-1', opts: { secretIsBase64: false, region: 'cn-north-1', service: 'imagex' } },
    { name: '6. UTF-8 secret, service=capcut, region=ap-singapore-1', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'capcut' } },
    { name: '7. UTF-8 secret + X-Tt-PSM header', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'imagex', extraHeaders: { 'x-tt-psm': 'capcut.teamwork.api' } } },
    { name: '8. Base64 secret + X-Tt-PSM header', opts: { secretIsBase64: true, region: 'ap-singapore-1', service: 'imagex', extraHeaders: { 'x-tt-psm': 'capcut.teamwork.api' } } },
    { name: '9. UTF-8 secret, service=imagex, region=singapore', opts: { secretIsBase64: false, region: 'singapore', service: 'imagex' } },
  ];

  for (const v of variants) {
    const query = {
      Action: 'ApplyImageUpload',
      Version: '2023-05-01',
      ServiceId: sts.service_id,
      UploadBytes: String(fileSize),
    };
    try {
      const signed = trySign({
        secretKey: sts.security_token.secret_access_key,
        accessKeyId: sts.security_token.access_key_id,
        sessionToken: sts.security_token.session_token,
        method: 'GET',
        path: '/',
        query,
        host: sts.upload_domain,
        body: '',
        ...v.opts,
      });
      const url = `https://${sts.upload_domain}/?${canonicalQueryString(query)}`;
      const res = await axios.get(url, {
        headers: {
          Host: sts.upload_domain,
          'X-Date': signed.longDate,
          'X-Content-Sha256': signed.headers['x-content-sha256'],
          'X-Security-Token': sts.security_token.session_token,
          Authorization: signed.authorization,
          ...(signed.headers['x-tt-psm'] ? { 'X-Tt-PSM': signed.headers['x-tt-psm'] } : {}),
        },
        timeout: 15000,
        validateStatus: () => true,
      });
      console.log(`${v.name}: ${res.status}`);
      if (res.status === 200 && res.data?.Result) {
        console.log(`  ✓✓✓ SUCCESS! Result:`, JSON.stringify(res.data.Result).slice(0, 300));
        console.log(`  variant opts:`, JSON.stringify(v.opts));
        return;
      }
      const err = res.data?.ResponseMetadata?.Error;
      if (err) console.log(`  ${err.Code}: ${err.Message.slice(0, 100)}`);
      else console.log(`  resp:`, JSON.stringify(res.data).slice(0, 200));
    } catch (e) {
      console.log(`${v.name}: ERROR - ${e.message}`);
    }
  }

  console.log('\n=== All variants failed ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
