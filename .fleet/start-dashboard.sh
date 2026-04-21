#!/usr/bin/env bash
# start-dashboard.sh — Launch the Agent Fleet Command Dashboard
# Starts the WebSocket bridge and opens the dashboard in the default browser

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FLEET_PORT="${FLEET_PORT:-27182}"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║    FLEET COMMAND — INITIALIZING...   ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# Ensure log files exist (in project root)
PROJECT_ROOT="$SCRIPT_DIR/.."
mkdir -p "$PROJECT_ROOT/.claude"
[ -f "$PROJECT_ROOT/.claude/agent-activity.log" ] || touch "$PROJECT_ROOT/.claude/agent-activity.log"
[ -f "$PROJECT_ROOT/.claude/agent-commands.json" ] || echo "[]" > "$PROJECT_ROOT/.claude/agent-commands.json"

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "  [WARN] Node.js not found — bridge will not start."
  echo "         Dashboard will run in offline polling mode."
  echo ""
else
  # Kill any existing bridge process on port 27182
  if command -v lsof &>/dev/null; then
    EXISTING_PID=$(lsof -ti :$FLEET_PORT 2>/dev/null || true)
    if [ -n "$EXISTING_PID" ]; then
      echo "  [INFO] Stopping existing bridge (PID: $EXISTING_PID)"
      kill "$EXISTING_PID" 2>/dev/null || true
      sleep 1
    fi
  fi

  # Open dashboard after a short delay to let bridge start
  DASHBOARD_URL="http://localhost:$FLEET_PORT/"

  (sleep 2 && \
    echo "" && \
    echo "  [OK] Opening Fleet Command dashboard at $DASHBOARD_URL" && \
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
      start "" "$DASHBOARD_URL"
    elif command -v xdg-open &>/dev/null; then
      xdg-open "$DASHBOARD_URL"
    elif command -v open &>/dev/null; then
      open "$DASHBOARD_URL"
    else
      echo "  [WARN] Could not detect browser. Open $DASHBOARD_URL manually."
    fi
  ) &

  echo ""
  echo "  ╔══════════════════════════════════════╗"
  echo "  ║       FLEET COMMAND ONLINE           ║"
  echo "  ╚══════════════════════════════════════╝"
  echo ""
  echo "  Dashboard: $DASHBOARD_URL"
  echo "  Log:       .claude/agent-activity.log"
  echo "  Commands:  .claude/agent-commands.json"
  echo "  Stop:      Ctrl+C"
  echo ""

  # Run bridge in foreground so it stays alive
  exec node agent-bridge.js
fi

# Fallback if no Node.js — just open the HTML file directly
DASHBOARD_URL="file://$SCRIPT_DIR/agent-dashboard.html"
echo "  [OK] Opening dashboard in offline mode at $DASHBOARD_URL"
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  start "" "$DASHBOARD_URL"
elif command -v xdg-open &>/dev/null; then
  xdg-open "$DASHBOARD_URL"
elif command -v open &>/dev/null; then
  open "$DASHBOARD_URL"
fi
echo ""
