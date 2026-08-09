#!/usr/bin/env python3
"""Run end-to-end render test on production server. Streams log until job completes."""
import sys
sys.path.insert(0, '/home/z/.local/lib/python3.13/site-packages')
import paramiko
import time

HOST = 'sakura.proxy.rlwy.net'
PORT = 39551
USER = 'root'
PASSWORD = 'Wifi.id123'

# Use a popular template with 2 placeholder images (the default in test-render.js)
# Template: 7598329412446375173 (default in test-render.js)
# Or we can use "Frame Collage Trend" we just searched: 7582506944926289157
TEMPLATE_ID = '7582506944926289157'  # Frame Collage Trend - 470k uses
IMAGE_URLS = [
    'https://cdn.nekohime.site/file/m8dh80bd.jpg',
    'https://cdn.nekohime.site/file/ar7dy0f6.jpg',
]

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=15)

# Run the test script in foreground with a 5-minute timeout.
# Output streams to stdout which we'll capture.
cmd = (
    f"cd ~/capcut && timeout 300 node scripts/test-render.js {TEMPLATE_ID} {' '.join(IMAGE_URLS)} 2>&1; "
    f"echo EXIT=$?"
)

print(f">>> Running test render with template {TEMPLATE_ID}")
print(f">>> Images: {len(IMAGE_URLS)} URLs")
print(f">>> Timeout: 300s (5 min)")
print(f">>> This will take 2-5 minutes. Streaming output...\n")
sys.stdout.flush()

# Use get_pty to get unbuffered output, then read in chunks
stdin, stdout, stderr = client.exec_command(cmd, timeout=320, get_pty=True)
channel = stdout.channel

while True:
    if channel.recv_ready():
        data = channel.recv(4096).decode('utf-8', errors='replace')
        if not data:
            break
        # Filter MOTD lines (first few lines we don't care about)
        print(data, end='', flush=True)
    if channel.exit_status_ready() and not channel.recv_ready():
        # Read any remaining
        while channel.recv_ready():
            data = channel.recv(4096).decode('utf-8', errors='replace')
            print(data, end='', flush=True)
        break
    time.sleep(0.2)

client.close()
print("\n>>> Test complete")
