// scripts/test-create-cloud-asset.js
//
// Try calling /lv/v1/asset/create_cloud_asset to register our VOD-uploaded
// asset as a CapCut cloud asset. The resulting asset_id might be what we need
// to use in the draft's materials.
//
// Based on bundle-035.js _getAssetInfoForCreating():
//   {
//     everphoto_id: <from prepare_upload>,
//     asset: {
//       uri, size, workspace_id, filename, upload_id,
//       preserve_video_multi_definition, if_image_async_resize,
//       transcode_template_type, permission, space_id, flags,
//       file_type, folder_id, meta: JSON.stringify({vid}), md5, no_copy
//     }
//   }

import fs from 'node:fs';
import path from 'node:path';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

const TEST_IMAGE = process.argv[2] || './test-assets/img1.jpg';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();
  console.log('Uploading asset via VOD...');
  const asset = await api.uploadAsset(TEST_IMAGE);
  console.log(`✓ vid=${asset.vid} uri=${asset.uri} md5=${asset.md5}\n`);
  const fileName = path.basename(TEST_IMAGE);

  // Try various variants of create_cloud_asset body
  const variants = [
    {
      label: 'V1-minimal',
      body: {
        asset: {
          uri: asset.uri,
          md5: asset.md5,
          size: asset.fileSize,
          workspace_id: api.workspaceId,
          filename: fileName,
          file_type: 'image',
        },
        is_web_user: true,
      },
    },
    {
      label: 'V2-with-vid-meta',
      body: {
        asset: {
          uri: asset.uri,
          md5: asset.md5,
          size: asset.fileSize,
          workspace_id: api.workspaceId,
          filename: fileName,
          file_type: 'image',
          space_id: '0',
          permission: 0,
          folder_id: '0',
          flags: 0,
          meta: JSON.stringify({ vid: asset.vid }),
          no_copy: false,
          if_image_async_resize: true,
        },
        is_web_user: true,
      },
    },
    {
      label: 'V3-flat-no-asset-wrap',
      body: {
        uri: asset.uri,
        md5: asset.md5,
        size: asset.fileSize,
        workspace_id: api.workspaceId,
        filename: fileName,
        file_type: 'image',
        space_id: '0',
        permission: 0,
        folder_id: '0',
        meta: JSON.stringify({ vid: asset.vid }),
        is_web_user: true,
      },
    },
    {
      label: 'V4-video-file-type',
      body: {
        asset: {
          uri: asset.uri,
          md5: asset.md5,
          size: asset.fileSize,
          workspace_id: api.workspaceId,
          filename: fileName,
          file_type: 'video',
          space_id: '0',
          permission: 0,
          folder_id: '0',
          flags: 0,
          meta: JSON.stringify({ vid: asset.vid }),
          no_copy: false,
          preserve_video_multi_definition: false,
          if_image_async_resize: true,
          transcode_template_type: 0,
        },
        is_web_user: true,
      },
    },
    {
      label: 'V5-everphoto_id',
      body: {
        everphoto_id: '0',
        asset: {
          uri: asset.uri,
          md5: asset.md5,
          size: asset.fileSize,
          workspace_id: api.workspaceId,
          filename: fileName,
          file_type: 'image',
          space_id: '0',
          permission: 0,
          folder_id: '0',
          flags: 0,
          upload_id: '0',
          meta: JSON.stringify({ vid: asset.vid }),
          no_copy: true,
          if_image_async_resize: true,
        },
        is_web_user: true,
      },
    },
  ];

  const results = [];
  for (const v of variants) {
    process.stdout.write(`  [${v.label}] `);
    try {
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/asset/create_cloud_asset',
        v.body
      );
      console.log(`✓ ret=${res.data?.ret} errmsg=${res.data?.errmsg}`);
      if (res.data?.ret === '0' || res.data?.ret === 0) {
        console.log('  ✓✓✓ SUCCESS!');
        console.log('  data:', JSON.stringify(res.data?.data, null, 2).slice(0, 1500));
        results.push({ ok: true, label: v.label, data: res.data?.data });
        fs.writeFileSync('./tmp/cloud-asset-success.json', JSON.stringify(res.data, null, 2));
        break;
      } else {
        console.log('  resp:', JSON.stringify(res.data, null, 2).slice(0, 500));
        results.push({ ok: false, label: v.label });
      }
    } catch (e) {
      console.log(`✗ err: ${e.message.slice(0, 80)}`);
      if (e.response?.data) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 500));
      results.push({ ok: false, label: v.label, err: e.message });
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
