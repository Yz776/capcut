#!/bin/bash
cd /data/root/capcut
pkill -9 -f 'capture-render' 2>/dev/null
pkill -9 -f chrome 2>/dev/null
sleep 1
rm -f .capcut-profile/SingletonLock .capcut-profile/SingletonCookie .capcut-profile/SingletonSocket
LOG=/data/root/capcut/tmp/capture-v3.log

# Use xvfb-run for virtual display so WebGL/SwiftShader can initialize
# CapCut editor needs WebGL to load — without xvfb it hangs at file input.
xvfb-run --auto-servernum --server-args='-screen 0 1440x900x24' \
  setsid nohup node scripts/capture-render-v3.js 7617043391162928401 > "$LOG" 2>&1 < /dev/null &
PID=$!
disown
echo "Started PID=$PID"
sleep 8
echo "---LOG---"
cat "$LOG" 2>/dev/null | head -30
echo "---PROC---"
ps aux | grep -E 'capture|chrome|Xvfb' | grep -v grep | head -5
