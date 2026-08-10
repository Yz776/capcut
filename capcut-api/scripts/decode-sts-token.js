// scripts/decode-sts-token.js
//
// Decode the STS token's session_token to find StoreRegion/PriorityRegion.
// The session_token format is "STS2<base64-of-JSON>" per ttuploader.js s1().

import fs from 'node:fs';
import CapCutDirectAPI from '../src/services/capcut-direct-api.js';

async function main() {
  console.log('=== Decode STS SessionToken ===\n');

  // Try to load from file first
  let sts;
  if (fs.existsSync('./tmp/sts-fresh.json')) {
    sts = JSON.parse(fs.readFileSync('./tmp/sts-fresh.json', 'utf8'));
    console.log('Loaded from ./tmp/sts-fresh.json');
  } else {
    console.log('Getting fresh STS...');
    const api = new CapCutDirectAPI();
    await api._init();
    const res = await api._axios.post(
      'https://edit-api-sg.capcut.com/lv/v1/asset/prepare_upload_cloud',
      { space_id: '0', workspace_id: api.workspaceId, is_web_user: true }
    );
    sts = res.data.data;
    fs.writeFileSync('./tmp/sts-fresh.json', JSON.stringify(sts, null, 2));
  }

  const sessionToken = sts.security_token.session_token;
  console.log(`session_token (first 50): ${sessionToken.slice(0, 50)}...`);
  console.log(`session_token starts with "STS2": ${sessionToken.startsWith('STS2')}`);

  // Skip "STS2" prefix and base64-decode
  const b64 = sessionToken.substring(4);
  const decoded1 = Buffer.from(b64, 'base64').toString('utf8');
  console.log(`\n--- Decoded level 1 (first 500) ---`);
  console.log(decoded1.slice(0, 500));

  let parsed1;
  try {
    parsed1 = JSON.parse(decoded1);
  } catch (e) {
    console.log(`\nLevel 1 JSON parse failed: ${e.message}`);
    console.log('Trying level 2 base64 decode...');
    const decoded2 = Buffer.from(decoded1, 'base64').toString('utf8');
    console.log(`Level 2 (first 500):`, decoded2.slice(0, 500));
    parsed1 = JSON.parse(decoded2);
  }
  console.log(`\n--- Parsed level 1 ---`);
  console.log(JSON.stringify(parsed1, null, 2).slice(0, 1500));

  // Per ttuploader.js s1():
  //   e = JSON.parse(JSON.parse(JSON.parse(atob(t)).PolicyString).Statement[0].Condition)
  // So: parse outer JSON → .PolicyString → parse JSON → .Statement[0].Condition
  if (parsed1.PolicyString) {
    console.log(`\n--- PolicyString found ---`);
    let policyObj;
    try {
      policyObj = JSON.parse(parsed1.PolicyString);
    } catch {
      policyObj = JSON.parse(Buffer.from(parsed1.PolicyString, 'base64').toString('utf8'));
    }
    console.log(JSON.stringify(policyObj, null, 2).slice(0, 1500));

    if (policyObj.Statement && policyObj.Statement[0]) {
      const condition = policyObj.Statement[0].Condition;
      console.log(`\n--- Condition ---`);
      console.log(JSON.stringify(condition, null, 2));
      console.log(`\nStoreRegion: ${condition?.StoreRegion || '(not set)'}`);
      console.log(`PriorityRegion: ${condition?.PriorityRegion || '(not set)'}`);
    }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
