#!/usr/bin/env python3
"""Start login:manual on remote server in true background (detach from SSH session)."""
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko
import time

HOST = "sakura.proxy.rlwy.net"
PORT = 39551
USER = "root"
PASSWORD = "Wifi.id123"


def start_login():
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
        # Use setsid to fully detach, no blocking on stdout
        cmd = (
            "cd ~/capcut && "
            "rm -f /tmp/login-manual.log && "
            "setsid nohup npm run login:manual > /tmp/login-manual.log 2>&1 < /dev/null & "
            "disown; "
            "echo 'LOGIN_STARTED'"
        )
        stdin, stdout, stderr = client.exec_command(cmd, timeout=10)
        # Don't wait for stdout - just send and exit
        try:
            stdout.read()
        except Exception:
            pass
        print("LOGIN_STARTED (background)")
    finally:
        client.close()


def check_log(wait_seconds: int = 20):
    """Wait and then read the log file."""
    print(f"\nWaiting {wait_seconds}s for script to produce output...")
    time.sleep(wait_seconds)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
        cmd = "cat /tmp/login-manual.log 2>/dev/null | tail -30"
        stdin, stdout, stderr = client.exec_command(cmd, timeout=15)
        out = stdout.read().decode("utf-8", errors="replace")
        print("=== LOG ===")
        print(out)
    finally:
        client.close()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "start"
    if mode == "start":
        start_login()
    elif mode == "log":
        wait = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        check_log(wait)
    elif mode == "status":
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
            cmd = "ps -ef | grep -E 'manual-login|chrome-linux' | grep -v grep | wc -l; ls -la ~/capcut/tmp/qr-latest.png 2>/dev/null"
            stdin, stdout, stderr = client.exec_command(cmd, timeout=15)
            out = stdout.read().decode("utf-8", errors="replace")
            print(out)
        finally:
            client.close()
