#!/bin/bash
# Run capture-render-api.js in background, log to file, exit immediately
cd /data/root/capcut
mkdir -p tmp
pkill -9 -f 'capture-render' 2>/dev/null
pkill -9 -f chrome 2>/dev/null
sleep 1
rm -f .capcut-profile/SingletonLock .capcut-profile/SingletonCookie .capcut-profile/SingletonSocket

LOG=/data/root/capcut/tmp/capture-run.log

# Use setsid to fully detach from ssh session
setsid nohup node scripts/capture-render-api.js 7617043391162928401 > "$LOG" 2>&1 < /dev/null &
PID=$!
disown
echo "Started PID=$PID"
sleep 5
echo "---LOG---"
cat "$LOG" 2>/dev/null | head -40
echo "---PROC---"
ps aux | grep -E 'capture|chrome' | grep -v grep | head -5
