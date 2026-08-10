// scripts/test-vod-signing-v2.js
//
// Try VOD upload signing with Origin/Referer headers (PSM check might need them).

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
function uriEncode(s, encodeSlash = true) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || ch === '-' || ch === '.' || ch === '_' || ch === '~') {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
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

function signRequest({ secretKey, secretIsBase64, accessKeyId, sessionToken, region, service, method, path, query, host, body, extraHeaders }) {
  const now = new Date();
  const shortDate = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const longDate = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

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

  return { headers, authorization, longDate };
}

async function main() {
  console.log('=== VOD Signing V2 (with Origin/Referer) ===\n');
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
  console.log(`STS retrieved. upload_domain=${sts.upload_domain}\n`);

  const fileSize = 61060;
  const query = {
    Action: 'ApplyImageUpload',
    Version: '2023-05-01',
    ServiceId: sts.service_id,
    UploadBytes: String(fileSize),
    FileExtension: 'jpg',
  };

  // Try variants WITH Origin/Referer headers (PSM check might use these)
  const variants = [
    { name: '1. UTF-8 secret + Origin/Referer + service=imagex', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'imagex', extraHeaders: { origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/' } } },
    { name: '2. Base64 secret + Origin/Referer + service=imagex', opts: { secretIsBase64: true, region: 'ap-singapore-1', service: 'imagex', extraHeaders: { origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/' } } },
    { name: '3. UTF-8 + Origin/Referer + service=vod', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'vod', extraHeaders: { origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/' } } },
    { name: '4. UTF-8 + Origin/Referer + X-Tt-PSM + service=imagex', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'imagex', extraHeaders: { origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/', 'x-tt-psm': 'capcut.teamwork.api' } } },
    { name: '5. UTF-8 + Origin + service=imagex + region=sg', opts: { secretIsBase64: false, region: 'sg', service: 'imagex', extraHeaders: { origin: 'https://www.capcut.com' } } },
    { name: '6. UTF-8 + service=capcut_teamwork_api', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'capcut_teamwork_api', extraHeaders: { origin: 'https://www.capcut.com' } } },
    { name: '7. UTF-8 + service=capcut', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'capcut', extraHeaders: { origin: 'https://www.capcut.com' } } },
    { name: '8. UTF-8 + service=teamwork', opts: { secretIsBase64: false, region: 'ap-singapore-1', service: 'teamwork', extraHeaders: { origin: 'https://www.capcut.com' } } },
  ];

  for (const v of variants) {
    try {
      const signed = signRequest({
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
      const reqHeaders = {
        Host: sts.upload_domain,
        'X-Date': signed.longDate,
        'X-Content-Sha256': signed.headers['x-content-sha256'],
        'X-Security-Token': sts.security_token.session_token,
        Authorization: signed.authorization,
      };
      if (signed.headers['origin']) reqHeaders.Origin = signed.headers['origin'];
      if (signed.headers['referer']) reqHeaders.Referer = signed.headers['referer'];
      if (signed.headers['x-tt-psm']) reqHeaders['X-Tt-PSM'] = signed.headers['x-tt-psm'];

      const res = await axios.get(url, { headers: reqHeaders, timeout: 15000, validateStatus: () => true });
      console.log(`${v.name}: ${res.status}`);
      if (res.status === 200 && res.data?.Result) {
        console.log(`  ✓✓✓ SUCCESS!`);
        console.log(`  Result:`, JSON.stringify(res.data.Result).slice(0, 500));
        return;
      }
      const err = res.data?.ResponseMetadata?.Error;
      if (err) console.log(`  ${err.Code}: ${err.Message.slice(0, 120)}`);
      else console.log(`  resp:`, JSON.stringify(res.data).slice(0, 250));
    } catch (e) {
      console.log(`${v.name}: ERROR - ${e.message}`);
    }
  }

  // Also try the older "ApplyUploadImageFile" action (might use simpler auth)
  console.log('\n--- Trying ApplyUploadImageFile with Origin ---');
  try {
    const q = { ...query, Action: 'ApplyUploadImageFile' };
    const signed = signRequest({
      secretKey: sts.security_token.secret_access_key,
      accessKeyId: sts.security_token.access_key_id,
      sessionToken: sts.security_token.session_token,
      method: 'GET',
      path: '/',
      query: q,
      host: sts.upload_domain,
      body: '',
      region: 'ap-singapore-1',
      service: 'imagex',
      extraHeaders: { origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/' },
    });
    const url = `https://${sts.upload_domain}/?${canonicalQueryString(q)}`;
    const res = await axios.get(url, {
      headers: {
        Host: sts.upload_domain,
        'X-Date': signed.longDate,
        'X-Content-Sha256': signed.headers['x-content-sha256'],
        'X-Security-Token': sts.security_token.session_token,
        Authorization: signed.authorization,
        Origin: 'https://www.capcut.com',
        Referer: 'https://www.capcut.com/',
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    console.log(`ApplyUploadImageFile: ${res.status}`);
    console.log(`  resp:`, JSON.stringify(res.data).slice(0, 500));
  } catch (e) { console.log('ApplyUploadImageFile:', e.message); }

  // Try a totally different endpoint: vod:ApplyUpload (not ImageX)
  console.log('\n--- Trying vod:ApplyUpload (not ImageX) ---');
  try {
    const q = {
      Action: 'ApplyUpload',
      Version: '2023-05-01',
      SpaceName: sts.service_id,
      UploadBytes: String(fileSize),
      FileExtension: 'jpg',
    };
    const signed = signRequest({
      secretKey: sts.security_token.secret_access_key,
      accessKeyId: sts.security_token.access_key_id,
      sessionToken: sts.security_token.session_token,
      method: 'GET',
      path: '/',
      query: q,
      host: sts.upload_domain,
      body: '',
      region: 'ap-singapore-1',
      service: 'vod',
      extraHeaders: { origin: 'https://www.capcut.com', referer: 'https://www.capcut.com/' },
    });
    const url = `https://${sts.upload_domain}/?${canonicalQueryString(q)}`;
    const res = await axios.get(url, {
      headers: {
        Host: sts.upload_domain,
        'X-Date': signed.longDate,
        'X-Content-Sha256': signed.headers['x-content-sha256'],
        'X-Security-Token': sts.security_token.session_token,
        Authorization: signed.authorization,
        Origin: 'https://www.capcut.com',
        Referer: 'https://www.capcut.com/',
      },
      timeout: 15000,
      validateStatus: () => true,
    });
    console.log(`ApplyUpload (vod): ${res.status}`);
    console.log(`  resp:`, JSON.stringify(res.data).slice(0, 500));
  } catch (e) { console.log('ApplyUpload:', e.message); }

  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
