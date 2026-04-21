#!/usr/bin/env bash
# Launches the Meta Harness service and broker in the background, leaving
# the Fleet dashboard to be started by its own .fleet/start-dashboard.sh.
# Refuses to run without META_HARNESS_ADMIN_TOKEN.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "${META_HARNESS_ADMIN_TOKEN:-}" ]; then
  echo "[meta-harness] META_HARNESS_ADMIN_TOKEN env var is required." >&2
  exit 1
fi

mkdir -p data/logs
HARNESS_LOG="$ROOT/data/logs/meta-harness.log"
BROKER_LOG="$ROOT/data/logs/meta-broker.log"

if [ ! -d node_modules ]; then
  echo "[meta-harness] installing deps..."
  npm install --no-audit --no-fund --loglevel=error
fi

# Kill previous instances on the port (best effort)
PORT="${META_HARNESS_PORT:-20000}"
for pid in $(netstat -ano 2>/dev/null | awk -v p=":$PORT " '$0 ~ p && $4 == "LISTENING" { print $5 }' | sort -u); do
  [ -n "$pid" ] && [ "$pid" != "0" ] && taskkill //F //PID "$pid" >/dev/null 2>&1 || true
done

echo "[meta-harness] starting service on :$PORT (log: $HARNESS_LOG)"
nohup node bin/meta-harness.js > "$HARNESS_LOG" 2>&1 &
HARNESS_PID=$!
echo "  pid=$HARNESS_PID"

# Give the service a moment to open its port
sleep 2

echo "[meta-harness] starting broker (log: $BROKER_LOG)"
nohup node bin/meta-broker.js > "$BROKER_LOG" 2>&1 &
BROKER_PID=$!
echo "  pid=$BROKER_PID"

cat <<EOF

  ╔══════════════════════════════════════════╗
  ║   META HARNESS STACK — UP                ║
  ╚══════════════════════════════════════════╝

  Service:  http://localhost:$PORT
  UI:       http://localhost:$PORT/ui/missions.html
  WS:       ws://localhost:$PORT/v1/events
  Logs:     $HARNESS_LOG
            $BROKER_LOG

  Fleet dashboard (if not already running):
            bash .fleet/start-dashboard.sh

EOF
