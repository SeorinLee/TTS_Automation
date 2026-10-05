#!/bin/bash
set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$ROOT_DIR/web"
LOG_DIR="$ROOT_DIR/logs"
PORT="${PORT:-3000}"
HOST="${GMV_HOST:-127.0.0.1}"
WORKER_PORT="${WORKER_PORT:-8000}"
WORKER_PID_FILE="$LOG_DIR/mac-worker.pid"
WEB_PID_FILE="$LOG_DIR/web.pid"
EXPECTED_WORKER_BUILD="firefox-germany-v45"
UI_VERSION="firefox-de-v12"

mkdir -p "$LOG_DIR"

stop_stale_listener() {
  local port="$1"
  local label="$2"
  local listener_pids
  listener_pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$listener_pids" ]; then
    echo "Stopping stale $label listener on port $port..."
    while IFS= read -r listener_pid; do
      [ -n "$listener_pid" ] && kill "$listener_pid" 2>/dev/null || true
    done <<< "$listener_pids"
    sleep 1
  fi
}

CURRENT_HEALTH="$(curl -fsS "http://127.0.0.1:$WORKER_PORT/health" 2>/dev/null || true)"
if [ -n "$CURRENT_HEALTH" ] && [[ "$CURRENT_HEALTH" != *"$EXPECTED_WORKER_BUILD"* ]]; then
  stop_stale_listener "$WORKER_PORT" "TikTok Worker"
fi

CURRENT_SELECTOR="$(curl -fsS "http://127.0.0.1:$PORT/browser-market-selector.js?v=12" 2>/dev/null || true)"
if [ -n "$CURRENT_SELECTOR" ] &&
   { [[ "$CURRENT_SELECTOR" != *"browser-market-selector-v12"* ]] ||
     [[ "$CURRENT_SELECTOR" != *"FIREFOX"* ]] ||
     [[ "$CURRENT_SELECTOR" != *'data-market="DE"'* ]]; }; then
  stop_stale_listener "$PORT" "TikTok web"
fi

WEB_RUNNING=0
WORKER_RUNNING=0

if [ -f "$WEB_PID_FILE" ]; then
  OLD_WEB_PID="$(cat "$WEB_PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_WEB_PID" ] && kill -0 "$OLD_WEB_PID" 2>/dev/null; then
    WEB_RUNNING=1
  fi
fi

if [ -f "$WORKER_PID_FILE" ]; then
  OLD_WORKER_PID="$(cat "$WORKER_PID_FILE" 2>/dev/null || true)"
  if [ -n "$OLD_WORKER_PID" ] && kill -0 "$OLD_WORKER_PID" 2>/dev/null; then
    WORKER_RUNNING=1
  fi
fi

if lsof -tiTCP:"$WORKER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  WORKER_RUNNING=1
fi

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  WEB_RUNNING=1
fi

if [ "$WEB_RUNNING" -eq 1 ] && [ "$WORKER_RUNNING" -eq 1 ]; then
  HEALTH_BODY="$(curl -fsS "http://127.0.0.1:$WORKER_PORT/health" 2>/dev/null || true)"
  SELECTOR_BODY="$(curl -fsS "http://$HOST:$PORT/browser-market-selector.js?v=12" 2>/dev/null || true)"
  if [[ "$HEALTH_BODY" == *"$EXPECTED_WORKER_BUILD"* ]] &&
     [[ "$SELECTOR_BODY" == *"browser-market-selector-v12"* ]] &&
     [[ "$SELECTOR_BODY" == *"FIREFOX"* ]] &&
     [[ "$SELECTOR_BODY" == *'data-market="DE"'* ]]; then
    echo "The latest Mac site and worker are already running at http://$HOST:$PORT"
    open "http://$HOST:$PORT/?ui=$UI_VERSION&portable=1&assets=12" 2>/dev/null || true
    exit 0
  fi

  echo "An older build is running. Restarting with Firefox + Germany support..."
  "$SCRIPT_DIR/stop-macos.sh" >/dev/null 2>&1 || true
  WEB_RUNNING=0
  WORKER_RUNNING=0
  sleep 1
fi

if [ ! -d "$WEB_DIR/node_modules" ] || [ ! -d "$WEB_DIR/.next" ]; then
  echo "The built web bundle is missing. Extract the complete ZIP first."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required for the macOS build. Install Node.js 18+ first."
  exit 1
fi

if ! lsof -tiTCP:"$WORKER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  nohup env WORKER_BASE_URL="http://127.0.0.1:$WORKER_PORT" PORT="$WORKER_PORT" HOSTNAME="127.0.0.1" \
    node "$ROOT_DIR/worker/mac-worker.js" > "$LOG_DIR/mac-worker.log" 2>&1 < /dev/null &
  WORKER_PID=$!
  echo "$WORKER_PID" > "$WORKER_PID_FILE"
  echo "Started macOS worker (PID: $WORKER_PID)"
else
  echo "A macOS worker is already running on port $WORKER_PORT"
  WORKER_PID="$(lsof -tiTCP:"$WORKER_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
fi

if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  nohup env WORKER_BASE_URL="http://127.0.0.1:$WORKER_PORT" PORT="$PORT" HOSTNAME="$HOST" \
    node "$WEB_DIR/server.js" > "$LOG_DIR/web.log" 2>&1 < /dev/null &
  WEB_PID=$!
  echo "$WEB_PID" > "$WEB_PID_FILE"
  echo "Started web app (PID: $WEB_PID)"
else
  echo "The Mac site is already running on port $PORT"
  WEB_PID="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
fi

sleep 3
open "http://$HOST:$PORT/?ui=$UI_VERSION&portable=1&assets=12" 2>/dev/null || true

printf "\nMac launcher is starting...\n"
printf "Web: http://%s:%s\n" "$HOST" "$PORT"
printf "Worker: http://127.0.0.1:%s/health\n" "$WORKER_PORT"
printf "Web log: %s/web.log\n" "$LOG_DIR"
printf "Worker log: %s/mac-worker.log\n" "$LOG_DIR"
printf "Web PID: %s\n" "$WEB_PID"
if [ -n "${WORKER_PID:-}" ]; then
  printf "Worker PID: %s\n" "$WORKER_PID"
fi
