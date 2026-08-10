// scripts/test-render-task.js
//
// Now that we can save a draft, try creating a render task.
// If this works, we have a pure-API render pipeline (no browser needed).

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

// Use the draft_id we just saved, or accept as CLI arg
const DRAFT_ID = process.argv[2] || '7672187086258045456';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Test render task (draft_id ${DRAFT_ID}) ===\n`);

  // Step 1: Verify draft exists via get_draft_detail
  console.log('--- Step 1: get_draft_detail ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/editor/plane_draft/get_draft_detail',
      {
        package_key: DRAFT_ID,
        app_version: '5.8.0',
        sdk_version: '16.1.0',
        lang: 'en-US',
        region: 'ID',
        workspace_id: api.workspaceId,
        package_asset_limit: 30,
      }
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    if (res.data?.data) {
      console.log('Draft data keys:', Object.keys(res.data.data));
      fs.writeFileSync('./tmp/draft-detail.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) { console.log('✗', e.message); }

  // Step 2: Create render task
  console.log('\n--- Step 2: create render task ---');
  let taskId = null;
  try {
    const submitId = `${Date.now()}_${Math.random()}`;
    const body = {
      app_version: '1.0.0.285',
      sdk_version: '127.0.0',
      extra: '{}',
      type: 0,
      region: 'SG',
      app_id: 348188,
      width: 1080,
      height: 1920,
      fps: 30,
      format: 'mp4',
      cover: '',
      duration: 10000,
      quality: 100,
      definition: '720p',
      task_id: '',
      video_name: 'Pure API Test',
      draft_id: DRAFT_ID,
      package_id: '',
      video_id: '',
      video_path: '',
      group_id: '',
      custom_info: '{}',
      from_workspace_id: api.workspaceId,
      to_workspace_id: api.workspaceId,
      force_export: false,
      submit_id: submitId,
    };
    console.log('Body:', JSON.stringify(body, null, 2));
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/render_task/create',
      body
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    console.log('Response:', JSON.stringify(res.data, null, 2));
    if (res.data?.data?.task_id) {
      taskId = res.data.data.task_id;
      console.log(`\n✓✓✓ RENDER TASK CREATED! task_id=${taskId}`);
      fs.writeFileSync('./tmp/render-task-created.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 1000));
  }

  // Step 3: Poll render task
  if (taskId) {
    console.log(`\n--- Step 3: poll render task ${taskId} ---`);
    let pollCount = 0;
    const startTime = Date.now();
    while (Date.now() - startTime < 120000) { // 2 min timeout
      pollCount++;
      try {
        const res = await api._axios.post(
          'https://edit-api-sg.capcut.com/lv/v1/render_task/batch_get',
          { task_ids: [taskId] }
        );
        const taskInfo = res.data?.data?.tasks?.[0] || res.data?.data?.task_list?.[0] || res.data?.data;
        const status = taskInfo?.status ?? taskInfo?.state;
        const progress = taskInfo?.progress || 0;
        const videoUrl = taskInfo?.video_url || taskInfo?.video?.url || taskInfo?.download_url;
        console.log(`  poll #${pollCount}: status=${status} progress=${progress} hasUrl=${!!videoUrl}`);
        if (pollCount <= 2 || pollCount % 5 === 0) {
          console.log('    raw:', JSON.stringify(taskInfo, null, 2).slice(0, 800));
        }

        if (status === 2 || status === 'success' || status === 'done' || status === 'completed') {
          console.log(`\n✓✓✓ RENDER COMPLETED!`);
          if (videoUrl) {
            console.log(`video_url: ${videoUrl}`);
            fs.writeFileSync('./tmp/render-result.json', JSON.stringify(taskInfo, null, 2));
            // Download the video
            console.log('\n--- Downloading video ---');
            try {
              const dlRes = await api.downloadVideo(videoUrl, './tmp/rendered-video.mp4');
              console.log('✓ Downloaded:', dlRes);
            } catch (e) { console.log('✗ download failed:', e.message); }
          }
          break;
        }
        if (status === 3 || status === 'failed' || status === 'error') {
          console.log(`\n✗ RENDER FAILED`);
          console.log(JSON.stringify(taskInfo, null, 2));
          break;
        }
      } catch (e) {
        console.log(`  poll #${pollCount} error:`, e.message);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
