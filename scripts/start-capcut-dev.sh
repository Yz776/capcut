#!/bin/bash
# Persistent Next.js dev launcher for capcut-api
set -e
cd /home/z/my-project/capcut-api

# Kill any existing next-server on port 3000
pkill -f "next-server" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 2

# Start dev server in background, detached
setsid nohup npm run dev > logs/dev.log 2>&1 < /dev/null &
PID=$!
disown

echo "Next.js dev server starting (parent PID=$PID)..."
sleep 15

# Find the actual next-server process
NEXT_PID=$(pgrep -f "next-server" | head -1)
if [ -n "$NEXT_PID" ]; then
  echo "[OK] next-server running, PID=$NEXT_PID"
else
  echo "[FAIL] No next-server process found"
  echo "---LOG---"
  tail -50 logs/dev.log
  exit 1
fi

# Test endpoint
echo "---TESTING HTTP---"
for i in 1 2 3 4 5; do
  CODE=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo "FAIL")
  if [ "$CODE" = "200" ]; then
    echo "[OK] HTTP 200 on attempt $i"
    break
  fi
  echo "Attempt $i: code=$CODE, waiting..."
  sleep 3
done

echo "---LOG TAIL---"
tail -20 logs/dev.log
