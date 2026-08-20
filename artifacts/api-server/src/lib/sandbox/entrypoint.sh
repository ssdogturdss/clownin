#!/bin/sh
set -eu

"$SANDBOX_RELAY_EXECUTABLE" "$SANDBOX_RELAY_SCRIPT" "$PORT" "$SANDBOX_BROKER_SOCKET" &
relay_pid=$!
"$@" &
app_pid=$!

cleanup() {
  kill "$app_pid" "$relay_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  wait "$relay_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

while kill -0 "$app_pid" 2>/dev/null; do
  sleep 1
done
wait "$app_pid"