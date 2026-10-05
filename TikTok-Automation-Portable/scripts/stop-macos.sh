#!/bin/bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$ROOT_DIR/logs"
WEB_PID_FILE="$LOG_DIR/web.pid"
WORKER_PID_FILE="$LOG_DIR/mac-worker.pid"

for PID_FILE in "$WEB_PID_FILE" "$WORKER_PID_FILE"; do
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      echo "Stopped process $PID"
    fi
    rm -f "$PID_FILE"
  fi
done

pkill -f "node .*server.js" 2>/dev/null || true
pkill -f "mac-worker\.js" 2>/dev/null || true

for PORT in 3000 8000; do
  ENDPOINT="http://127.0.0.1:$PORT/health"
  if [ "$PORT" -eq 3000 ]; then
    ENDPOINT="http://127.0.0.1:$PORT/api/health"
  fi
  if curl -fsS "$ENDPOINT" 2>/dev/null | grep -qE '"(worker|build|web_build)"'; then
    for LISTENER_PID in $(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
      kill "$LISTENER_PID" 2>/dev/null || true
      echo "Stopped TikTok listener $LISTENER_PID on port $PORT"
    done
  fi
done

echo "TikTok GMV macOS stack stopped."
