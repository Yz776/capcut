#!/usr/bin/env python3
"""SSH into production server and run debug commands."""
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko

HOST = "sakura.proxy.rlwy.net"
PORT = 39551
USER = "root"
PASSWORD = "Wifi.id123"


def run_remote(commands: str, timeout: int = 60) -> str:
    """Run commands on remote server and return output."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)
        stdin, stdout, stderr = client.exec_command(commands, timeout=timeout)
        # Set channel timeout too
        stdout.channel.settimeout(timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return out + (("\n--- STDERR ---\n" + err) if err.strip() else "")
    finally:
        client.close()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        # If first arg is a number, use as timeout
        if sys.argv[1].isdigit():
            timeout = int(sys.argv[1])
            cmd = " ".join(sys.argv[2:])
        else:
            timeout = 60
            cmd = " ".join(sys.argv[1:])
    else:
        timeout = 60
        cmd = "ls ~/capcut"
    print(f">>> {cmd} (timeout={timeout}s)")
    print(run_remote(cmd, timeout=timeout))
