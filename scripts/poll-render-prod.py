#!/usr/bin/env python3
"""Poll render job status on production server until completion."""
import sys
import time
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko

HOST = 'sakura.proxy.rlwy.net'
PORT = 39551
USER = 'root'
PASSWORD = 'Wifi.id123'

JOB_ID = sys.argv[1] if len(sys.argv) > 1 else 'm29g6B8g3o50'
MAX_WAIT_SEC = int(sys.argv[2]) if len(sys.argv) > 2 else 300

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)

start = time.time()
last_progress = -1
last_message = ''

print(f">>> Polling job {JOB_ID} for up to {MAX_WAIT_SEC}s\n")

import json
while time.time() - start < MAX_WAIT_SEC:
    try:
        # Reconnect each iteration to avoid stale channel timeouts
        if not client.get_transport() or not client.get_transport().is_active():
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
        
        cmd = f"curl -s http://127.0.0.1:7000/render/status/{JOB_ID}"
        stdin, stdout, stderr = client.exec_command(cmd, timeout=10)
        out = stdout.read().decode('utf-8', errors='replace')
    except Exception as e:
        print(f"  [reconnect after error: {e.__class__.__name__}]")
        try: client.close()
        except: pass
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
        time.sleep(3)
        continue
    
    json_start = out.find('{')
    if json_start == -1:
        print(f"  [no JSON in response]: {out[:200]}")
        time.sleep(5)
        continue
    
    try:
        job = json.loads(out[json_start:])
    except json.JSONDecodeError as e:
        print(f"  [JSON parse error]: {e}")
        time.sleep(5)
        continue
    
    elapsed = int(time.time() - start)
    if job.get('progress') != last_progress or job.get('message') != last_message:
        print(f"  [{elapsed:3d}s] {job.get('progress', 0):3d}% — {job.get('message', '(no msg)')} [status={job.get('status')}]")
        last_progress = job.get('progress')
        last_message = job.get('message')
        sys.stdout.flush()
    
    if job.get('status') in ('completed', 'failed'):
        print()
        print("=" * 60)
        if job.get('status') == 'completed':
            print(f"  ✓ JOB COMPLETED in {elapsed}s")
            print(f"  Video URL: {job.get('videoUrl')}")
        else:
            print(f"  ✗ JOB FAILED in {elapsed}s")
            print(f"  Error: {job.get('error')}")
        print("=" * 60)
        break
    
    time.sleep(8)
else:
    print(f"\n>>> Timed out after {MAX_WAIT_SEC}s. Job still running.")

try: client.close()
except: pass
