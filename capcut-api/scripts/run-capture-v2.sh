#!/bin/bash
cd /data/root/capcut
pkill -9 -f 'capture-render' 2>/dev/null
pkill -9 -f chrome 2>/dev/null
sleep 1
rm -f .capcut-profile/SingletonLock .capcut-profile/SingletonCookie .capcut-profile/SingletonSocket
LOG=/data/root/capcut/tmp/capture-v2.log
setsid nohup node scripts/capture-render-v2.js 7617043391162928401 > "$LOG" 2>&1 < /dev/null &
PID=$!
disown
echo "Started PID=$PID"
sleep 5
echo "---LOG---"
cat "$LOG" 2>/dev/null | head -30
echo "---PROC---"
ps aux | grep -E 'capture|chrome' | grep -v grep | head -3
