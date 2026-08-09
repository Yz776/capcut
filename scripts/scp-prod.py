#!/usr/bin/env python3
"""Download file from production server via base64-encoded SSH stdout with markers."""
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko
import base64
import re

HOST = "sakura.proxy.rlwy.net"
PORT = 39551
USER = "root"
PASSWORD = "Wifi.id123"


def download_via_base64(remote_path: str, local_path: str) -> None:
    """Stream file content as base64 via SSH stdout with start/end markers."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
        # Use markers so we can filter out MOTD/banner noise
        cmd = f'echo "B64START"; base64 < {remote_path}; echo "B64END"'
        stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")

        # Extract content between markers
        m = re.search(r"B64START\n(.*?)\nB64END", out, re.DOTALL)
        if not m:
            print(f"ERROR: markers not found in output.\nOUT: {out[:500]}\nERR: {err[:500]}", file=sys.stderr)
            sys.exit(1)

        b64_data = m.group(1).replace("\n", "").replace("\r", "")
        raw = base64.b64decode(b64_data)
        with open(local_path, "wb") as f:
            f.write(raw)
        print(f"OK: {remote_path} -> {local_path} ({len(raw)} bytes)")
    finally:
        client.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python3 scp-prod.py <remote_path> <local_path>")
        sys.exit(1)
    download_via_base64(sys.argv[1], sys.argv[2])
