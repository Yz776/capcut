// scripts/test-vod-upload.js
//
// Test the VOD/ImageX upload flow using STS credentials from CapCut.
//
// Steps tested:
//   1. Get fresh STS credentials (Mode A prepare_upload_cloud)
//   2. ApplyImageUpload → get UploadHost + StoreUri + Auth
//   3. Upload file bytes to UploadHost
//   4. CommitImageUpload → finalize, get image CDN URL
//   5. (if all OK) Mode B prepare_upload_cloud → upload_id
//   6. (if all OK) create_cloud_asset → asset_id
//
// Run: node scripts/test-vod-upload.js [image-path]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';
import * as vodUploader from '../src/services/vod-uploader.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function main() {
  console.log(`\n=== VOD Upload Test ===`);
  console.log(`Test image: ${TEST_IMAGE}\n`);

  if (!fs.existsSync(TEST_IMAGE)) {
    console.error(`✗ Test image not found: ${TEST_IMAGE}`);
    process.exit(1);
  }

  const fileBuf = fs.readFileSync(TEST_IMAGE);
  const fileSize = fileBuf.length;
  const fileName = path.basename(TEST_IMAGE);
  const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');
  console.log(`File: ${fileName} size=${fileSize} md5=${md5}`);

  const api = new CapCutDirectAPI();
  await api._init();

  // === STEP 1: Get fresh STS credentials ===
  console.log('\n--- Step 1: prepare_upload_cloud Mode A (STS init) ---');
  let sts = null;
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/asset/prepare_upload_cloud',
      { space_id: '0', workspace_id: api.workspaceId, is_web_user: true }
    );
    if (res.data?.ret !== '0') {
      throw new Error(`ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
    }
    sts = res.data.data;
    console.log(`✓ STS retrieved`);
    console.log(`  upload_domain: ${sts.upload_domain}`);
    console.log(`  service_id: ${sts.service_id}`);
    console.log(`  app_id: ${sts.app_id}`);
    console.log(`  everphoto_user_id: ${sts.everphoto_user_id}`);
    console.log(`  access_key_id: ${sts.security_token.access_key_id.slice(0, 20)}...`);
    fs.writeFileSync('./tmp/sts-fresh.json', JSON.stringify(sts, null, 2));
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data).slice(0, 400));
    process.exit(1);
  }

  // === STEP 2: ApplyImageUpload ===
  console.log('\n--- Step 2: ApplyImageUpload ---');
  let applyResult = null;
  try {
    applyResult = await vodUploader.applyImageUpload(sts, {
      serviceId: sts.service_id,
      fileSize,
      fileName,
    });
    console.log(`✓ ApplyImageUpload succeeded`);
    console.log(`  UploadHost: ${applyResult.UploadHost || applyResult.upload_host}`);
    console.log(`  StoreUri: ${applyResult.StoreUri || applyResult.store_uri}`);
    console.log(`  Auth: ${(applyResult.Auth || applyResult.auth || '').slice(0, 50)}...`);
    console.log(`  Full result:`, JSON.stringify(applyResult, null, 2).slice(0, 600));
    fs.writeFileSync('./tmp/apply-image-upload.json', JSON.stringify(applyResult, null, 2));
  } catch (e) {
    console.log('✗ ApplyImageUpload failed:', e.message);
    if (e.response) {
      console.log('  status:', e.response.status);
      console.log('  resp:', JSON.stringify(e.response.data).slice(0, 800));
    }
    // Try alternative flow
    console.log('\n--- Trying ApplyUploadImageFile alternative ---');
    try {
      const alt = await vodUploader.uploadImageViaUploadImageFile(sts, TEST_IMAGE);
      console.log('  alt result:', JSON.stringify(alt, null, 2).slice(0, 800));
      fs.writeFileSync('./tmp/apply-upload-image-file.json', JSON.stringify(alt, null, 2));
    } catch (e2) {
      console.log('  alt also failed:', e2.message);
      if (e2.response) console.log('  alt resp:', JSON.stringify(e2.response.data).slice(0, 400));
    }
    process.exit(1);
  }

  // === STEP 3: Upload file bytes ===
  console.log('\n--- Step 3: Upload file bytes to UploadHost ---');
  try {
    const ext = path.extname(TEST_IMAGE).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
    const upRes = await vodUploader.uploadImageBytes(applyResult, fileBuf, contentType);
    console.log(`✓ Upload succeeded, status=${upRes.status}`);
    console.log('  response:', JSON.stringify(upRes.response).slice(0, 300));
  } catch (e) {
    console.log('✗ Upload failed:', e.message);
    if (e.response) {
      console.log('  status:', e.response.status);
      console.log('  resp:', JSON.stringify(e.response.data).slice(0, 800));
    }
    process.exit(1);
  }

  // === STEP 4: CommitImageUpload ===
  console.log('\n--- Step 4: CommitImageUpload ---');
  let commitResult = null;
  try {
    commitResult = await vodUploader.commitImageUpload(sts, {
      serviceId: sts.service_id,
      storeUris: [applyResult.StoreUri || applyResult.store_uri],
    });
    console.log(`✓ CommitImageUpload succeeded`);
    console.log(`  Result:`, JSON.stringify(commitResult, null, 2).slice(0, 800));
    fs.writeFileSync('./tmp/commit-image-upload.json', JSON.stringify(commitResult, null, 2));
  } catch (e) {
    console.log('✗ Commit failed:', e.message);
    if (e.response) {
      console.log('  status:', e.response.status);
      console.log('  resp:', JSON.stringify(e.response.data).slice(0, 800));
    }
    // Continue anyway — the upload bytes were already sent, we can still try
    // create_cloud_asset which uses the StoreUri.
    console.log('  Continuing anyway — StoreUri is still usable for create_cloud_asset');
  }

  // === STEP 5: Mode B prepare_upload_cloud → upload_id ===
  console.log('\n--- Step 5: prepare_upload_cloud Mode B (per-file) ---');
  let modeB = null;
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/asset/prepare_upload_cloud',
      {
        workspace_id: api.workspaceId,
        space_id: '0',
        md5,
        size: fileSize,
        file_type: 'image',
        flags: 0,
        is_web_user: true,
      }
    );
    if (res.data?.ret !== '0') {
      throw new Error(`ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
    }
    modeB = res.data.data;
    console.log(`✓ Mode B succeeded`);
    console.log(`  upload_id: ${modeB.upload_id}`);
    console.log(`  everphoto_user_id: ${modeB.everphoto_user_id}`);
    fs.writeFileSync('./tmp/mode-b.json', JSON.stringify(modeB, null, 2));
  } catch (e) {
    console.log('✗ Mode B failed:', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data).slice(0, 400));
    process.exit(1);
  }

  // === STEP 6: create_cloud_asset ===
  console.log('\n--- Step 6: create_cloud_asset ---');
  let assetId = '';
  let assetUrl = '';
  try {
    const storeUri = applyResult.StoreUri || applyResult.store_uri;
    const assetBody = {
      everphoto_id: sts.everphoto_user_id,
      asset: {
        size: fileSize,
        workspace_id: api.workspaceId,
        filename: fileName,
        upload_id: modeB.upload_id,
        if_image_async_resize: true,
        space_id: '0',
        flags: 0,
        file_type: 'image',
        folder_id: '',
        meta: '{}',
        md5,
        no_copy: false,
        uri: storeUri,
      },
      is_web_user: true,
    };
    console.log('Body:', JSON.stringify(assetBody, null, 2).slice(0, 800));
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/asset/create_cloud_asset',
      assetBody
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Asset data:', JSON.stringify(res.data.data, null, 2).slice(0, 1500));
      assetId = res.data.data.asset_id || res.data.data.id || '';
      assetUrl = res.data.data.file_url || res.data.data.url || '';
      fs.writeFileSync('./tmp/cloud-asset-created.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) {
    console.log('✗ create_cloud_asset failed:', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data).slice(0, 800));
    process.exit(1);
  }

  console.log(`\n=== SUCCESS ===`);
  console.log(`asset_id: ${assetId}`);
  console.log(`asset_url: ${assetUrl}`);
  console.log(`store_uri: ${applyResult.StoreUri || applyResult.store_uri}`);
  console.log(`main_url (commit): ${commitResult && (Array.isArray(commitResult) ? commitResult[0]?.MainUrl : commitResult?.MainUrl)}`);

  // Write a summary file for downstream test scripts
  fs.writeFileSync('./tmp/upload-success.json', JSON.stringify({
    asset_id: assetId,
    asset_url: assetUrl,
    store_uri: applyResult.StoreUri || applyResult.store_uri,
    main_url: commitResult && (Array.isArray(commitResult) ? commitResult[0]?.MainUrl : commitResult?.MainUrl),
    md5,
    file_size: fileSize,
    file_name: fileName,
  }, null, 2));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
