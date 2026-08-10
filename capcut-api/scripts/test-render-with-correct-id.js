// scripts/test-render-with-correct-id.js
//
// KEY FIX: Use the ORIGINAL package_key (the one we generated) as draft_id,
// NOT the package_id returned by plane_draft/save.
//
// Previous test confirmed: get_draft_detail with package_key="1786320257190272"
// returned ret=0 SUCCESS. So the draft exists under that key.

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

// Use the ORIGINAL package_key we generated in test-save-draft.js
const DRAFT_ID = process.argv[2] || '1786320257190272';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log(`\n=== Test render with correct draft_id (${DRAFT_ID}) ===\n`);

  // Step 1: Verify draft exists
  console.log('--- Step 1: get_draft_detail (verify) ---');
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
      const td = res.data.data.template_data;
      if (td) {
        console.log('template_data length:', td.length || '(object)');
        if (typeof td === 'string') {
          try {
            const parsed = JSON.parse(td);
            console.log('template_data parsed keys:', Object.keys(parsed));
          } catch {}
        }
      }
      console.log('package_id:', res.data.data.package_id);
      fs.writeFileSync('./tmp/draft-detail-full.json', JSON.stringify(res.data, null, 2));
    }
  } catch (e) { console.log('✗', e.message); }

  // Step 2: Create render task with the ORIGINAL package_key as draft_id
  // Body schema from bundle-018.js offset 96764 — NO submit_id field
  console.log('\n--- Step 2: create render task (no submit_id) ---');
  let taskId = null;
  try {
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
      video_name: 'Pure API Render',
      draft_id: DRAFT_ID,
      package_id: '',
      video_id: '',
      video_path: '',
      group_id: '',
      custom_info: '{}',
      from_workspace_id: api.workspaceId,
      to_workspace_id: api.workspaceId,
      force_export: false,
    };
    console.log('Body:', JSON.stringify(body, null, 2));
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/render_task/create',
      body
    );
    console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
    console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1500));
    if (res.data?.data?.task_id && String(res.data.data.task_id) !== '0') {
      taskId = res.data.data.task_id;
      console.log(`\n✓✓✓ RENDER TASK CREATED! task_id=${taskId}`);
      fs.writeFileSync('./tmp/render-task-created.json', JSON.stringify(res.data, null, 2));
    } else {
      console.log('\n✗ task_id is 0 or missing — render task not actually created');
    }
  } catch (e) {
    console.log('✗', e.message);
    if (e.response) console.log('  resp:', JSON.stringify(e.response.data, null, 2).slice(0, 800));
  }

  // Step 2b: Try with different field combinations
  if (!taskId) {
    console.log('\n--- Step 2b: try with package_id instead of draft_id ---');
    try {
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
        video_name: 'Pure API Render',
        draft_id: '',
        package_id: '7672187086258045456', // the returned package_id
        video_id: '',
        video_path: '',
        group_id: '',
        custom_info: '{}',
        from_workspace_id: api.workspaceId,
        to_workspace_id: api.workspaceId,
        force_export: false,
      };
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/render_task/create',
        body
      );
      console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
      console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1000));
      if (res.data?.data?.task_id && String(res.data.data.task_id) !== '0') {
        taskId = res.data.data.task_id;
        console.log(`\n✓✓✓ RENDER TASK CREATED with package_id! task_id=${taskId}`);
      }
    } catch (e) { console.log('✗', e.message); }
  }

  // Step 2c: Try with both draft_id and package_id
  if (!taskId) {
    console.log('\n--- Step 2c: try with both draft_id and package_id ---');
    try {
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
        video_name: 'Pure API Render',
        draft_id: DRAFT_ID,
        package_id: '7672187086258045456',
        video_id: '',
        video_path: '',
        group_id: '',
        custom_info: '{}',
        from_workspace_id: api.workspaceId,
        to_workspace_id: api.workspaceId,
        force_export: false,
      };
      const res = await api._axios.post(
        'https://edit-api-sg.capcut.com/lv/v1/render_task/create',
        body
      );
      console.log(`ret=${res.data?.ret} errmsg="${res.data?.errmsg || ''}"`);
      console.log('Response:', JSON.stringify(res.data, null, 2).slice(0, 1000));
      if (res.data?.data?.task_id && String(res.data.data.task_id) !== '0') {
        taskId = res.data.data.task_id;
        console.log(`\n✓✓✓ RENDER TASK CREATED with both! task_id=${taskId}`);
      }
    } catch (e) { console.log('✗', e.message); }
  }

  // Step 3: Poll render task
  if (taskId) {
    console.log(`\n--- Step 3: poll render task ${taskId} ---`);
    const startTime = Date.now();
    let pollCount = 0;
    while (Date.now() - startTime < 180000) { // 3 min
      pollCount++;
      try {
        const res = await api._axios.post(
          'https://edit-api-sg.capcut.com/lv/v1/render_task/batch_get',
          { task_ids: [taskId] }
        );
        const taskInfo = res.data?.data?.tasks?.[0] || res.data?.data?.task_list?.[0] || res.data?.data?.render_task || res.data?.data;
        const status = taskInfo?.status ?? taskInfo?.state;
        const progress = taskInfo?.progress || 0;
        const videoUrl = taskInfo?.video_url || taskInfo?.video?.url || taskInfo?.download_url;
        console.log(`  poll #${pollCount}: status=${status} progress=${progress} hasUrl=${!!videoUrl}`);
        if (pollCount <= 3 || pollCount % 10 === 0) {
          console.log('    raw:', JSON.stringify(taskInfo, null, 2).slice(0, 800));
        }
        if (status === 2 || status === 'success' || status === 'done' || status === 'completed') {
          console.log(`\n✓✓✓ RENDER COMPLETED!`);
          if (videoUrl) {
            console.log(`video_url: ${videoUrl}`);
            fs.writeFileSync('./tmp/render-result.json', JSON.stringify(taskInfo, null, 2));
            try {
              const dlRes = await api.downloadVideo(videoUrl, './tmp/rendered-video.mp4');
              console.log('✓✓✓✓✓ VIDEO DOWNLOADED:', dlRes);
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
