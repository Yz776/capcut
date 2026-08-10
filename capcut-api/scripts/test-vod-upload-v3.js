// scripts/test-vod-upload-v3.js
//
// V3: Use /lv/v1/upload_sign with biz="replicate" (the REAL token source).
// Try both VOD (ApplyUpload + SpaceName) and ImageX (ApplyImageUpload + ServiceId).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';
import { signAwsV4Request } from '../src/services/vod-uploader.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

function canonicalQueryString(params) {
  return Object.keys(params).sort().map(k => {
    const kEnc = encodeURIComponent(k).replace(/[^A-Za-z0-9_.~%-]/g, escape).replace(/[*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const vEnc = encodeURIComponent(params[k]).replace(/[^A-Za-z0-9_.~%-]/g, escape).replace(/[*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${kEnc}=${vEnc}`;
  }).join('&');
}

async function tryUpload(tokenData, label) {
  console.log(`\n=== ${label} ===`);
  const stsToken = {
    accessKeyId: tokenData.access_key_id,
    secretAccessKey: tokenData.secret_access_key,
    sessionToken: tokenData.session_token,
  };
  const fileBuf = fs.readFileSync(TEST_IMAGE);
  const fileSize = fileBuf.length;
  const fileName = path.basename(TEST_IMAGE);
  const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
  const ext = path.extname(TEST_IMAGE).toLowerCase().replace('.', '');
  const spaceName = tokenData.space_name;

  console.log(`space_name: ${spaceName}`);
  console.log(`file: ${fileName} size=${fileSize} md5=${md5.slice(0, 16)}... ext=${ext}`);

  // Try multiple combinations
  const variants = [
    // 1. VOD ApplyUpload with SpaceName (region=i18n, service=vod)
    {
      name: '1. VOD ApplyUpload + SpaceName (region=i18n)',
      query: { Action: 'ApplyUpload', Version: '2020-11-19', SpaceName: spaceName, UploadBytes: String(fileSize) },
      region: 'i18n', service: 'vod',
    },
    // 2. VOD ApplyUpload with SpaceName (region=ap-singapore-1)
    {
      name: '2. VOD ApplyUpload + SpaceName (region=ap-singapore-1)',
      query: { Action: 'ApplyUpload', Version: '2020-11-19', SpaceName: spaceName, UploadBytes: String(fileSize) },
      region: 'ap-singapore-1', service: 'vod',
    },
    // 3. VOD ApplyUploadInner with SpaceName
    {
      name: '3. VOD ApplyUploadInner + SpaceName',
      query: { Action: 'ApplyUploadInner', Version: '2020-11-19', SpaceName: spaceName, UploadBytes: String(fileSize) },
      region: 'i18n', service: 'vod',
    },
    // 4. ImageX ApplyImageUpload with ServiceId=spaceName
    {
      name: '4. ImageX ApplyImageUpload + ServiceId (region=i18n)',
      query: { Action: 'ApplyImageUpload', Version: '2018-08-01', ServiceId: spaceName, UploadBytes: String(fileSize), FileExtension: ext },
      region: 'i18n', service: 'imagex',
    },
    // 5. ImageX ApplyImageUpload with ServiceId=spaceName (region=ap-singapore-1)
    {
      name: '5. ImageX ApplyImageUpload + ServiceId (region=ap-singapore-1)',
      query: { Action: 'ApplyImageUpload', Version: '2018-08-01', ServiceId: spaceName, UploadBytes: String(fileSize), FileExtension: ext },
      region: 'ap-singapore-1', service: 'imagex',
    },
  ];

  const host = 'vod-ap-singapore-1.bytevcloudapi.com';
  for (const v of variants) {
    try {
      const signed = signAwsV4Request({
        method: 'GET',
        pathname: '/',
        query: v.query,
        headers: { host },
        body: '',
        accessKeyId: stsToken.accessKeyId,
        secretAccessKey: stsToken.secretAccessKey,
        sessionToken: stsToken.sessionToken,
        region: v.region,
        service: v.service,
      });
      const url = `https://${host}/?${canonicalQueryString(v.query)}`;
      const res = await axios.get(url, {
        headers: {
          Host: host,
          'X-Amz-Date': signed.amzDate,
          'x-amz-security-token': stsToken.sessionToken,
          Authorization: signed.authorization,
        },
        timeout: 15000,
        validateStatus: () => true,
      });
      console.log(`\n${v.name}: ${res.status}`);
      const err = res.data?.ResponseMetadata?.Error;
      const result = res.data?.Result;
      if (err) {
        console.log(`  ✗ ${err.Code || '(no code)'}: ${err.Message?.slice(0, 150)}`);
      } else if (result) {
        console.log(`  ✓✓✓ SUCCESS!`);
        console.log(`  Result keys:`, Object.keys(result));
        console.log(`  Result:`, JSON.stringify(result, null, 2).slice(0, 1000));
        fs.writeFileSync('./tmp/vod-success.json', JSON.stringify({ variant: v.name, result, query: v.query, region: v.region, service: v.service }, null, 2));
        return { variant: v, result };
      } else {
        console.log(`  resp:`, JSON.stringify(res.data).slice(0, 400));
      }
    } catch (e) {
      console.log(`\n${v.name}: ERROR - ${e.message}`);
    }
  }
  return null;
}

async function main() {
  console.log('=== VOD Upload V3 ===\n');
  const api = new CapCutDirectAPI();
  await api._init();

  // Get tokens for both biz types
  console.log('--- Getting /lv/v1/upload_sign tokens ---');
  const tokens = {};
  for (const biz of ['replicate', 'web_video', 'temp_file']) {
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/upload_sign',
        { key_version: 'v5', biz }
      );
      if (res.data?.data) {
        tokens[biz] = res.data.data;
        console.log(`biz=${biz}: space_name=${res.data.data.space_name} region=${res.data.data.region || '(empty)'}`);
      }
    } catch (e) {
      console.log(`biz=${biz}: ${e.message}`);
    }
  }

  // Try each token
  for (const [biz, tokenData] of Object.entries(tokens)) {
    const result = await tryUpload(tokenData, `biz=${biz}`);
    if (result) {
      console.log(`\n✓✓✓ Found working combination with biz=${biz}`);
      break;
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
