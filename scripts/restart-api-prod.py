#!/usr/bin/env python3
"""Restart API server on production via uploaded startup script."""
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko
import base64
import time

HOST = 'sakura.proxy.rlwy.net'
PORT = 39551
USER = 'root'
PASSWORD = 'Wifi.id123'

# Shell script that fully detaches node, then exits immediately
SH_SCRIPT = '''#!/bin/bash
set -e
# Kill old instances
pkill -9 -f 'node src/index.js' 2>/dev/null || true
pkill -9 -f 'chrome' 2>/dev/null || true
sleep 2
# Cleanup locks
rm -f /root/capcut/.capcut-profile/SingletonLock /root/capcut/.capcut-profile/SingletonCookie /root/capcut/.capcut-profile/SingletonSocket 2>/dev/null || true
# Truncate log
> /tmp/capcut-api.log
# Start fully detached via setsid+nohup
cd /root/capcut
setsid nohup node src/index.js > /tmp/capcut-api.log 2>&1 < /dev/null &
disown
echo "STARTED_OK"
exit 0
'''

b64 = base64.b64encode(SH_SCRIPT.encode()).decode()

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)

# Upload script, make executable, run, then verify
cmd = f"echo '{b64}' | base64 -d > /tmp/restart-api.sh && chmod +x /tmp/restart-api.sh && /tmp/restart-api.sh"
stdin, stdout, stderr = client.exec_command(cmd, timeout=15)
out = stdout.read().decode('utf-8', errors='replace')
err = stderr.read().decode('utf-8', errors='replace')
print("=== Restart script output ===")
print(out[-500:])
if err.strip(): print("STDERR:", err[-200:])

# Wait, then verify
print("\n=== Waiting 8s for API to start ===")
time.sleep(8)

cmd = "cat /tmp/capcut-api.log | tail -10; echo '---'; ps -ef | grep 'node src' | grep -v grep | head -2; echo '---'; ss -tlnp 2>/dev/null | grep ':7000'; echo '---'; curl -s http://127.0.0.1:7000/health"
stdin, stdout, stderr = client.exec_command(cmd, timeout=15)
out = stdout.read().decode('utf-8', errors='replace')
lines = out.split('\n')
for i, line in enumerate(lines):
    if 'level' in line or '---' in line or 'root' in line or 'LISTEN' in line or '{' in line:
        print('\n'.join(lines[i:]))
        break
else:
    print(out[-2000:])

client.close()
