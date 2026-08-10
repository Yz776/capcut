// scripts/test-upload-sign.js
//
// Test the /v1/upload_sign endpoint discovered in bundle-035.js.
// This is the REAL endpoint the editor uses to get STS tokens for upload.
//   POST /v1/upload_sign
//   Body: {key_version: "v5", biz: "replicate" | "web_video" | "temp_file" | "user_avatar"}
//   Returns: STS token + imageHost/imageConfig + videoHost/videoConfig
//
// Run: node scripts/test-upload-sign.js

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';
import * as vodUploader from '../src/services/vod-uploader.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function main() {
  console.log('=== /v1/upload_sign Test ===\n');

  const api = new CapCutDirectAPI();
  await api._init();

  // === Step 1: Call /lv/v1/upload_sign with biz="replicate" (for images) ===
  console.log('--- Step 1: /lv/v1/upload_sign biz=replicate ---');
  let uploadToken = null;
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/upload_sign',
      { key_version: 'v5', biz: 'replicate' }
    );
    console.log(`HTTP ${res.status}`);
    console.log(`Full response:`, JSON.stringify(res.data, null, 2).slice(0, 4000));
    if (res.data) {
      if (res.data.data) uploadToken = res.data.data;
      else if (res.data.result || res.data.Result) uploadToken = res.data.result || res.data.Result;
      else if (res.data.access_key_id || res.data.AccessKeyID) uploadToken = res.data;
      if (uploadToken) fs.writeFileSync('./tmp/upload-sign-replicate.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data).slice(0, 500));
  }

  // Also try biz="web_video"
  console.log('\n--- /lv/v1/upload_sign biz=web_video ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/upload_sign',
      { key_version: 'v5', biz: 'web_video' }
    );
    console.log(`HTTP ${res.status}`);
    console.log(`Full response:`, JSON.stringify(res.data, null, 2).slice(0, 4000));
    fs.writeFileSync('./tmp/upload-sign-web-video.json', JSON.stringify(res.data, null, 2));
    if (!uploadToken && res.data?.data) uploadToken = res.data.data;
    if (!uploadToken && (res.data?.result || res.data?.Result)) uploadToken = res.data.result || res.data.Result;
    if (!uploadToken && (res.data?.access_key_id || res.data?.AccessKeyID)) uploadToken = res.data;
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data).slice(0, 500));
  }

  if (!uploadToken) {
    console.log('\n✗ No upload token — stopping.');
    return;
  }

  // === Step 2: Inspect what fields the upload_sign returns ===
  console.log('\n--- Step 2: Inspect upload_sign response structure ---');
  // Likely structure based on ttuploader.js config:
  //   uploadToken = {
  //     access_key_id / AccessKeyID,
  //     secret_access_key / SecretAccessKey,
  //     session_token / SessionToken,
  //     imageHost, imageConfig: { serviceId },
  //     videoHost, videoConfig: { spaceName },
  //     region, upload_domain, service_id, ...
  //   }
  const stsToken = {
    AccessKeyID: uploadToken.access_key_id || uploadToken.AccessKeyID || uploadToken.AccessKeyId,
    SecretAccessKey: uploadToken.secret_access_key || uploadToken.SecretAccessKey,
    SessionToken: uploadToken.session_token || uploadToken.SessionToken,
  };
  console.log('STS token fields:', Object.keys(stsToken));
  console.log(`AccessKeyID: ${stsToken.AccessKeyID?.slice(0, 30) || '(missing)'}`);
  console.log(`SecretAccessKey: ${stsToken.SecretAccessKey?.slice(0, 20) || '(missing)'}`);
  console.log(`SessionToken: ${stsToken.SessionToken?.slice(0, 30) || '(missing)'}`);

  // Find imageHost and imageConfig
  const imageHost = uploadToken.image_host || uploadToken.imageHost || uploadToken.upload_domain;
  const imageConfig = uploadToken.image_config || uploadToken.imageConfig || {};
  const serviceId = imageConfig.service_id || imageConfig.serviceId || uploadToken.service_id;
  console.log(`imageHost: ${imageHost}`);
  console.log(`imageConfig:`, JSON.stringify(imageConfig).slice(0, 300));
  console.log(`serviceId: ${serviceId}`);
  console.log(`region: ${uploadToken.region || '(not set, will use i18n)'}`);

  if (!stsToken.AccessKeyID || !stsToken.SecretAccessKey || !stsToken.SessionToken) {
    console.log('\n✗ Missing STS credentials — cannot continue.');
    console.log('Full response for debugging:');
    console.log(JSON.stringify(uploadToken, null, 2).slice(0, 4000));
    return;
  }

  // === Step 3: Try ApplyImageUpload with the new STS token ===
  console.log('\n--- Step 3: ApplyImageUpload with /lv/v1/upload_sign token ---');
  const spaceName = uploadToken.space_name || uploadToken.spaceName;
  // Use space_name as ImageX service_id, and the default ByteDance VOD host
  const sts = {
    upload_domain: 'vod-ap-singapore-1.bytevcloudapi.com',
    service_id: spaceName,  // 'lv-replicate' for biz=replicate
    security_token: {
      access_key_id: stsToken.AccessKeyID,
      secret_access_key: stsToken.SecretAccessKey,
      session_token: stsToken.SessionToken,
    },
  };
  console.log(`Using host=${sts.upload_domain} serviceId=${sts.service_id}`);

  // Decode session_token to verify policy
  try {
    const decoded = JSON.parse(Buffer.from(stsToken.SessionToken.substring(4), 'base64').toString('utf8'));
    if (decoded.PolicyString) {
      const policy = JSON.parse(decoded.PolicyString);
      console.log(`Policy:`, JSON.stringify(policy, null, 2));
    }
  } catch (e) {
    console.log(`Couldn't decode policy: ${e.message}`);
  }

  const fileBuf = fs.readFileSync(TEST_IMAGE);
  const fileSize = fileBuf.length;
  const fileName = path.basename(TEST_IMAGE);
  const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
  console.log(`File: ${fileName} size=${fileSize} md5=${md5.slice(0, 16)}...`);

  let applyResult = null;
  try {
    applyResult = await vodUploader.applyImageUpload(sts, {
      serviceId: sts.service_id,
      fileSize,
      fileName,
      region: uploadToken.region || 'i18n',
    });
    console.log(`✓ ApplyImageUpload succeeded!`);
    console.log(`Result:`, JSON.stringify(applyResult, null, 2).slice(0, 1500));
    fs.writeFileSync('./tmp/apply-image-upload-v2.json', JSON.stringify(applyResult, null, 2));
  } catch (e) {
    console.log('✗ ApplyImageUpload failed:', e.message);
    if (e.response) {
      console.log('  status:', e.response.status);
      console.log('  resp:', JSON.stringify(e.response.data).slice(0, 800));
    }
    return;
  }

  // === Step 4: Upload file bytes ===
  console.log('\n--- Step 4: Upload file bytes ---');
  try {
    const ext = path.extname(TEST_IMAGE).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
    const upRes = await vodUploader.uploadImageBytes(applyResult, fileBuf, contentType);
    console.log(`✓ Upload succeeded, status=${upRes.status}`);
  } catch (e) {
    console.log('✗ Upload failed:', e.message);
    if (e.response) {
      console.log('  status:', e.response.status);
      console.log('  resp:', JSON.stringify(e.response.data).slice(0, 800));
    }
    return;
  }

  // === Step 5: CommitImageUpload ===
  console.log('\n--- Step 5: CommitImageUpload ---');
  try {
    const uploadAddress = applyResult.UploadAddress || applyResult.uploadAddress;
    const sessionKey = uploadAddress.SessionKey || uploadAddress.sessionKey;
    const commitResult = await vodUploader.commitImageUpload(sts, {
      serviceId: sts.service_id,
      sessionKey,
      region: uploadToken.region || 'i18n',
    });
    console.log(`✓ CommitImageUpload succeeded!`);
    console.log(`Result:`, JSON.stringify(commitResult, null, 2).slice(0, 1500));
    fs.writeFileSync('./tmp/commit-image-upload-v2.json', JSON.stringify(commitResult, null, 2));
  } catch (e) {
    console.log('✗ Commit failed:', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data).slice(0, 800));
  }

  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
