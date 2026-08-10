#!/usr/bin/env python3
"""Deploy full capcut-api source tree to production server via tar+base64 over SSH."""
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko
import base64
import io
import os
import tarfile
import time

HOST = "sakura.proxy.rlwy.net"
PORT = 39551
USER = "root"
PASSWORD = "Wifi.id123"

LOCAL_ROOT = "/home/z/my-project/capcut-api"
# What we ship to production
SHIPPED_PATHS = [
    "src",
    "scripts",
    "package.json",
    "README.md",
    "REVERSE_ENGINEERED.md",
    ".env.example",
    ".gitignore",
]


def build_tarball() -> bytes:
    """Build a tar.gz of the project in memory."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel in SHIPPED_PATHS:
            full = os.path.join(LOCAL_ROOT, rel)
            if not os.path.exists(full):
                print(f"WARN: skipping missing path {full}")
                continue
            tar.add(full, arcname=rel, recursive=True)
    return buf.getvalue()


def main():
    if not os.path.isdir(LOCAL_ROOT):
        print(f"ERROR: {LOCAL_ROOT} not found", file=sys.stderr)
        sys.exit(1)

    print(f"[1/5] Building tarball of {LOCAL_ROOT}...")
    raw = build_tarball()
    b64 = base64.b64encode(raw).decode("ascii")
    print(f"    Tarball size: {len(raw)} bytes ({len(b64)} base64 chars)")

    print(f"[2/5] Connecting to {HOST}:{PORT}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=20)

    print("[3/5] Uploading tarball (base64 over SSH)...")
    # Pipe b64 to remote base64 -d > /tmp/capcut-deploy.tar.gz
    cmd = "base64 -d > /tmp/capcut-deploy.tar.gz"
    stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
    # Send in chunks to avoid huge single write
    chunk_size = 65536
    for i in range(0, len(b64), chunk_size):
        stdin.write(b64[i:i + chunk_size])
    stdin.flush()
    stdin.channel.shutdown_write()
    exit_status = stdout.channel.recv_exit_status()
    if exit_status != 0:
        err = stderr.read().decode("utf-8", errors="replace")
        print(f"ERROR uploading: exit={exit_status}\n{err}", file=sys.stderr)
        sys.exit(1)
    print("    Upload OK.")

    print("[4/5] Extracting tarball on remote + rsync into /root/capcut/...")
    extract_script = r'''
set -e
cd /root/capcut
# Backup current src
TS=$(date +%s)
mkdir -p /root/capcut-backups
tar czf /root/capcut-backups/capcut-src-$TS.tar.gz src scripts 2>/dev/null || true
# Extract new
mkdir -p /tmp/capcut-extract
tar -xzf /tmp/capcut-deploy.tar.gz -C /tmp/capcut-extract
# Sync files in (preserve .env, node_modules, .capcut-profile, downloads, etc.)
cp -rf /tmp/capcut-extract/src /root/capcut/
cp -rf /tmp/capcut-extract/scripts /root/capcut/
cp -f /tmp/capcut-extract/package.json /root/capcut/ 2>/dev/null || true
cp -f /tmp/capcut-extract/README.md /root/capcut/ 2>/dev/null || true
cp -f /tmp/capcut-extract/REVERSE_ENGINEERED.md /root/capcut/ 2>/dev/null || true
cp -f /tmp/capcut-extract/.env.example /root/capcut/ 2>/dev/null || true
cp -f /tmp/capcut-extract/.gitignore /root/capcut/ 2>/dev/null || true
# Cleanup
rm -rf /tmp/capcut-extract /tmp/capcut-deploy.tar.gz
# Make sure node_modules is still intact
ls /root/capcut/node_modules/express >/dev/null 2>&1 && echo "MODULES_OK" || echo "MODULES_MISSING"
# Verify new files exist
echo "---NEW FILES---"
ls -la /root/capcut/src/routes/
ls -la /root/capcut/src/utils/
echo "---DONE---"
'''
    stdin, stdout, stderr = client.exec_command(extract_script, timeout=60)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    print(out)
    if err.strip():
        print("STDERR:", err)

    print("[5/5] Restarting API server...")
    # Use the existing restart script logic inline
    restart_script = '''#!/bin/bash
set -e
pkill -9 -f 'node src/index.js' 2>/dev/null || true
sleep 2
> /tmp/capcut-api.log
cd /root/capcut
setsid nohup node src/index.js > /tmp/capcut-api.log 2>&1 < /dev/null &
disown
echo "STARTED_OK"
exit 0
'''
    rb64 = base64.b64encode(restart_script.encode()).decode()
    cmd = f"echo '{rb64}' | base64 -d > /tmp/restart-api.sh && chmod +x /tmp/restart-api.sh && /tmp/restart-api.sh"
    stdin, stdout, stderr = client.exec_command(cmd, timeout=20)
    out = stdout.read().decode("utf-8", errors="replace")
    print("Restart output:", out.strip())

    print("\nWaiting 10s for API to start...")
    time.sleep(10)

    print("Verifying health...")
    stdin, stdout, stderr = client.exec_command(
        "tail -30 /tmp/capcut-api.log; echo '---'; curl -s http://127.0.0.1:7000/health; echo; echo '---'; "
        "curl -s http://127.0.0.1:7000/ | head -c 500",
        timeout=20,
    )
    out = stdout.read().decode("utf-8", errors="replace")
    print(out)

    client.close()
    print("\n=== DEPLOY COMPLETE ===")


if __name__ == "__main__":
    main()
