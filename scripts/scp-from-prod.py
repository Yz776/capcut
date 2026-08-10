#!/usr/bin/env python3
"""Download files from production server via base64-encoded SSH stdout."""
import sys
import os
import base64
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko

HOST = "sakura.proxy.rlwy.net"
PORT = 39551
USER = "root"
PASSWORD = "Wifi.id123"


def download(remote_path: str, local_path: str) -> int:
    """Download a file by base64-encoding it on the remote (with markers) and decoding locally."""
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
        # Use markers to escape MOTD banner that pollutes stdout
        marker = "Z_B64_BEGIN_Z"
        end_marker = "Z_B64_END_Z"
        cmd = f"echo {marker}; base64 -w0 {remote_path!r}; echo; echo {end_marker}"
        stdin, stdout, stderr = client.exec_command(cmd, timeout=180)
        raw = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        # Extract between markers
        i = raw.find(marker)
        j = raw.find(end_marker)
        if i < 0 or j < 0 or j <= i:
            print(f"  ERROR markers not found for {remote_path}")
            if err.strip():
                print(f"  stderr: {err[:500]}")
            return 0
        b64 = raw[i + len(marker):j].strip()
        # Remove any whitespace/newlines
        b64 = "".join(b64.split())
        if not b64:
            print(f"  ERROR empty base64 for {remote_path}")
            return 0
        try:
            data = base64.b64decode(b64)
        except Exception as e:
            print(f"  base64 decode error: {e}")
            return 0
        with open(local_path, "wb") as f:
            f.write(data)
        print(f"  {remote_path} -> {local_path} ({len(data)} bytes)")
        return len(data)
    finally:
        client.close()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: scp-from-prod.py <remote_path> <local_path> [<remote_path2> <local_path2> ...]")
        sys.exit(1)
    pairs = [(sys.argv[i], sys.argv[i+1]) for i in range(1, len(sys.argv), 2)]
    total = 0
    for r, l in pairs:
        total += download(r, l)
    print(f"\nTotal: {total} bytes ({len(pairs)} files)")
