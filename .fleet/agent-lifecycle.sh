#!/usr/bin/env bash
# agent-lifecycle.sh — Called by Claude Code hooks for automatic activity logging
# Usage: ./agent-lifecycle.sh <event>
#   Events: start, heartbeat, stop
# Set CLAUDE_AGENT_NAME env var to identify the agent (e.g., "architect")
# If not set, tries to detect from CLAUDE_AGENT_FILE or defaults to "operator"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Try to determine agent name from multiple sources
if [ -n "${CLAUDE_AGENT_NAME:-}" ]; then
  AGENT="$CLAUDE_AGENT_NAME"
elif [ -n "${CLAUDE_AGENT_FILE:-}" ]; then
  # Extract agent name from file path like .claude/agents/architect.md
  AGENT="$(basename "${CLAUDE_AGENT_FILE}" .md)"
else
  AGENT="operator"
fi

MODEL="${CLAUDE_AGENT_MODEL:-sonnet}"
EVENT="${1:-heartbeat}"
PROJECT_ROOT="$SCRIPT_DIR/.."
HEARTBEAT_DIR="$PROJECT_ROOT/.claude/agent-heartbeats"
HEARTBEAT_FILE="$HEARTBEAT_DIR/$AGENT.heartbeat"

mkdir -p "$HEARTBEAT_DIR" 2>/dev/null || true

case "$EVENT" in
  start)
    date -u +"%Y-%m-%dT%H:%M:%SZ" > "$HEARTBEAT_FILE" 2>/dev/null || true
    "$SCRIPT_DIR/log-agent-activity.sh" "$AGENT" active "Session started (auto-logged)" "$MODEL" 2>/dev/null || true
    ;;
  heartbeat)
    date -u +"%Y-%m-%dT%H:%M:%SZ" > "$HEARTBEAT_FILE" 2>/dev/null || true
    ;;
  stop)
    "$SCRIPT_DIR/log-agent-activity.sh" "$AGENT" complete "Session ended (auto-logged)" "$MODEL" 2>/dev/null || true
    rm -f "$HEARTBEAT_FILE" 2>/dev/null || true
    ;;
esac
