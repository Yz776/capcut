#!/usr/bin/env python3
"""Upload file to production server via base64-encoded SSH stdin with markers."""
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko
import base64
import os
import re

HOST = "sakura.proxy.rlwy.net"
PORT = 39551
USER = "root"
PASSWORD = "Wifi.id123"


def upload_via_base64(local_path: str, remote_path: str) -> None:
    """Upload file content as base64 via SSH stdin to a remote file."""
    if not os.path.exists(local_path):
        print(f"ERROR: local file not found: {local_path}", file=sys.stderr)
        sys.exit(1)

    with open(local_path, "rb") as f:
        raw = f.read()
    b64_data = base64.b64encode(raw).decode("ascii")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)

        # Write base64 to a temp file on the remote, then decode it.
        # This avoids shell escaping issues with the file content.
        # We pipe the b64 data through stdin to a remote `base64 -d > remote_path`.
        cmd = f'base64 -d > {remote_path}'
        stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
        stdin.write(b64_data)
        stdin.flush()
        stdin.channel.shutdown_write()

        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        exit_status = stdout.channel.recv_exit_status()

        if exit_status != 0:
            print(f"ERROR: remote exit={exit_status}\nOUT: {out}\nERR: {err}", file=sys.stderr)
            sys.exit(1)

        # Verify size
        verify_cmd = f'stat -c %s {remote_path}'
        _, vstdout, _ = client.exec_command(verify_cmd, timeout=10)
        remote_size = vstdout.read().decode().strip()

        print(f"OK: {local_path} ({len(raw)} bytes) -> {remote_path} (remote reports {remote_size} bytes)")
    finally:
        client.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python3 scp-upload-prod.py <local_path> <remote_path>")
        sys.exit(1)
    upload_via_base64(sys.argv[1], sys.argv[2])
