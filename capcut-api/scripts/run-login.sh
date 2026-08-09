#!/bin/bash
# scripts/run-login.sh - start Xvfb + browser login interaktif
# Run: bash scripts/run-login.sh

set -e
cd /home/z/my-project/capcut-api

# Kill old processes
pkill -f Xvfb 2>/dev/null || true
pkill -f login-interactive 2>/dev/null || true
pkill -f chromium 2>/dev/null || true
sleep 2

# Start Xvfb (keep alive in foreground of script's background)
Xvfb :99 -screen 0 1440x900x24 -ac +extension RANDR +extension GLX +render -noreset &
XVFB_PID=$!
sleep 3

# Trap to cleanup on exit
trap "kill $XVFB_PID 2>/dev/null; pkill -f chromium 2>/dev/null; exit 0" EXIT INT TERM

# Start login script
DISPLAY=:99 node scripts/login-interactive.js &
LOGIN_PID=$!

# Wait for login script
wait $LOGIN_PID
EXIT_CODE=$?
echo "Login script exited with code $EXIT_CODE"
exit $EXIT_CODE
