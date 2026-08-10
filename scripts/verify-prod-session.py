#!/usr/bin/env python3
"""Verify CapCut session validity on production server."""
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko

HOST = 'sakura.proxy.rlwy.net'
PORT = 39551
USER = 'root'
PASSWORD = 'Wifi.id123'

# Use ESM import (project is type: module)
NODE_SCRIPT = r'''
import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: 'new',
  userDataDir: '.capcut-profile',
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
});
try {
  const page = await browser.newPage();
  await page.goto('https://www.capcut.com/my-cloud/material', {waitUntil:'domcontentloaded', timeout:20000});
  await new Promise(r=>setTimeout(r,3000));
  const url = page.url();
  const title = await page.title().catch(()=>'(no title)');
  console.log('Final URL:', url);
  console.log('Title:', title);
  const isUserCloud = /\/my-cloud\/\d+/.test(url);
  const isLogin = /\/login/.test(url);
  console.log('Login redirect:', isLogin);
  console.log('User cloud redirect:', isUserCloud);
  if (isUserCloud) { console.log('VERDICT: LOGIN VALID - session is good'); process.exit(0); }
  if (isLogin) { console.log('VERDICT: LOGIN EXPIRED - need to re-login'); process.exit(2); }
  console.log('VERDICT: AMBIGUOUS - check manually'); process.exit(1);
} catch (e) {
  console.error('ERR:', e.message); process.exit(3);
} finally {
  await browser.close();
}
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)

# Write the node script to a temp file on the remote, then run it
import base64
b64 = base64.b64encode(NODE_SCRIPT.encode()).decode()

cmd = f'''cd ~/capcut
echo "=== Kill all chrome processes ==="
pkill -9 -f 'chrome' 2>/dev/null
sleep 2
rm -f .capcut-profile/SingletonLock .capcut-profile/SingletonCookie .capcut-profile/SingletonSocket 2>/dev/null
ps -ef | grep chrome | grep -v grep | wc -l

echo
echo "=== Cookie file in profile ==="
ls -la .capcut-profile/Default/Cookies 2>&1

echo
echo "=== Writing verify-session-inline.js to project dir ==="
echo "{b64}" | base64 -d > ~/capcut/scripts/_verify-session-inline.js
ls -la ~/capcut/scripts/_verify-session-inline.js

echo
echo "=== Running session check (timeout 40s) ==="
timeout 40 node ~/capcut/scripts/_verify-session-inline.js 2>&1
echo "EXIT_CODE=$?"

echo
echo "=== Cleanup ==="
rm -f ~/capcut/scripts/_verify-session-inline.js
'''

stdin, stdout, stderr = client.exec_command(cmd, timeout=60)
out = stdout.read().decode('utf-8', errors='replace')
err = stderr.read().decode('utf-8', errors='replace')
lines = out.split('\n')
# Skip MOTD banner - find first '===' line
for i, line in enumerate(lines):
    if '===' in line:
        print('\n'.join(lines[i:]))
        break
else:
    print(out[-3000:])
if err.strip():
    print('--- STDERR ---')
    print(err[-300:])
client.close()
