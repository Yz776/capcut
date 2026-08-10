// scripts/test-auth-verify.js
//
// Verify that the updated headers (appvr=15.4.0, tdid=web) still produce
// valid signed requests for the endpoints that previously worked.

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

async function main() {
  const api = new CapCutDirectAPI();
  await api._init();

  console.log('\n=== Auth verification ===\n');

  // 1. Account info
  console.log('--- /passport/web/account/info/ ---');
  try {
    const res = await api._axios.get('https://www.capcut.com/passport/web/account/info/');
    console.log('ret=', res.data?.data?.ret, 'has user=', !!res.data?.data?.user);
    if (res.data?.data?.user) {
      console.log('  user_id:', res.data.data.user.uid);
      console.log('  email:', res.data.data.user.email);
    }
  } catch (e) { console.log('✗', e.message); }

  // 2. get_user_workspaces
  console.log('\n--- /cc/v1/workspace/get_user_workspaces ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/get_user_workspaces',
      { cursor: '0', count: 100, need_convert_workspace: true }
    );
    console.log('ret=', res.data?.ret, 'errmsg=', res.data?.errmsg);
    if (res.data?.data?.workspace_infos) {
      const ws = res.data.data.workspace_infos[0];
      console.log('  workspace_id:', ws.workspace_id);
      console.log('  space_id:', ws.space_id);
      console.log('  space_host:', ws.space_host);
      console.log('  region:', ws.region);
    }
  } catch (e) { console.log('✗', e.message); }

  // 3. mget_workspace_info (was failing)
  console.log('\n--- /cc/v1/workspace/mget_workspace_info ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/mget_workspace_info',
      { workspace_ids: [api.workspaceId] }
    );
    console.log('ret=', res.data?.ret, 'errmsg=', res.data?.errmsg);
  } catch (e) { console.log('✗', e.message); }

  // 4. get_all_everphoto_user (was failing)
  console.log('\n--- /cc/v1/workspace/get_all_everphoto_user ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/get_all_everphoto_user',
      { workspace_id: api.workspaceId }
    );
    console.log('ret=', res.data?.ret, 'errmsg=', res.data?.errmsg);
  } catch (e) { console.log('✗', e.message); }

  // 5. Check what cookies we're sending
  console.log('\n--- All cookies being sent ---');
  const cookies = api.cookieHeader.split(';').map(s => s.trim());
  for (const c of cookies) {
    // Show name and first 30 chars of value
    const eq = c.indexOf('=');
    const name = eq > 0 ? c.slice(0, eq) : c;
    const value = eq > 0 ? c.slice(eq + 1) : '';
    console.log(`  ${name} = ${value.slice(0, 60)}${value.length > 60 ? '...' : ''}`);
  }
  console.log('  total cookies:', cookies.length);

  // 6. Try sending the EXACT same headers as the editor
  console.log('\n--- mget_workspace_info with editor-like headers (lan=zh-CN) ---');
  try {
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/cc/v1/workspace/mget_workspace_info',
      { workspace_ids: [api.workspaceId] },
      { headers: { lan: 'zh-CN' } }  // editor used zh-CN
    );
    console.log('ret=', res.data?.ret, 'errmsg=', res.data?.errmsg);
  } catch (e) { console.log('✗', e.message); }

  console.log('\n=== done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
