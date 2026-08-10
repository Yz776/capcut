#!/bin/bash
# Run pure-API render in background on production
pkill -9 -f 'node scripts/test-pure' 2>/dev/null
pkill -9 -f chrome 2>/dev/null
sleep 2
rm -f /data/root/capcut/.capcut-profile/SingletonLock
cd /data/root/capcut
nohup node scripts/test-pure-api-render.js ./test-assets/img1.jpg > /tmp/pure-api.log 2>&1 &
PID=$!
echo "Started PID=$PID"
echo $PID > /tmp/pure-api.pid
sleep 5
echo "5s elapsed. Log so far:"
cat /tmp/pure-api.log 2>/dev/null
