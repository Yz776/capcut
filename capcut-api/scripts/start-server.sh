#!/bin/bash
# scripts/start-server.sh
#
# Start the CapCut JJ API server in the background, properly detached
# from the parent shell so it survives terminal/session close.
#
# Usage: bash scripts/start-server.sh [port]
# Default port: 7000 (or whatever .env specifies)

set -e
cd "$(dirname "$0")/.."

# Kill any existing instance
pkill -f 'node src/index.js' 2>/dev/null || true
sleep 2

# Start server in a detached subshell
# The ( ... ) subshell + & backgrounds the process
# nohup + </dev/null + 2>&1 detaches stdio
# disown removes it from the shell's job table
(
  nohup node src/index.js > /tmp/capcut-server.log 2>&1 < /dev/null &
  echo $! > /tmp/capcut-server.pid
)

sleep 4

# Verify it started
SERVER_PID=$(pgrep -f 'node src/index.js' || echo "")
if [ -z "$SERVER_PID" ]; then
  echo "✗ Server failed to start. Check /tmp/capcut-server.log"
  tail -20 /tmp/capcut-server.log
  exit 1
fi

# Find the actual port (auto-fallback)
PORT=$(grep 'listening on http://' /tmp/capcut-server.log | head -1 | grep -oE ':[0-9]+' | tail -1 | tr -d ':')

echo "✓ CapCut JJ API started"
echo "  PID:  $SERVER_PID"
echo "  Port: $PORT"
echo "  Log:  /tmp/capcut-server.log"
echo ""
echo "Endpoints:"
echo "  http://localhost:$PORT/          - Server info"
echo "  http://localhost:$PORT/health    - Health check"
echo "  http://localhost:$PORT/login     - Login form (paste cookies here)"
echo "  http://localhost:$PORT/login/status - Check session status"
echo "  http://localhost:$PORT/templates - List templates (no login needed)"
echo "  http://localhost:$PORT/render-direct - Render via pure API (needs login)"
echo ""
echo "To stop: kill $SERVER_PID  (or: pkill -f 'node src/index.js')"
