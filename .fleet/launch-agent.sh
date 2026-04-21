#!/usr/bin/env bash
# launch-agent.sh — Wrapper to launch a Claude Code agent with automatic lifecycle logging
# Usage: ./launch-agent.sh <agent-name> [model] [additional claude args...]
# Example: ./launch-agent.sh architect opus
#          ./launch-agent.sh backend sonnet "Build the auth API"

set -euo pipefail

AGENT_NAME="${1:?Usage: launch-agent.sh <agent-name> [model] [args...]}"
AGENT_MODEL="${2:-sonnet}"
shift 2 2>/dev/null || shift 1 2>/dev/null || true

export CLAUDE_AGENT_NAME="$AGENT_NAME"
export CLAUDE_AGENT_MODEL="$AGENT_MODEL"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
cd "$PROJECT_ROOT"

# Auto-log start
"$SCRIPT_DIR/agent-lifecycle.sh" start

# Launch Claude Code with the agent definition
claude --agent ".claude/agents/${AGENT_NAME}.md" "$@"
EXIT_CODE=$?

# Fallback: if Stop hook didn't fire (e.g., kill -9), log completion here
if [ -f ".claude/agent-heartbeats/${AGENT_NAME}.heartbeat" ]; then
  "$SCRIPT_DIR/agent-lifecycle.sh" stop
fi

exit $EXIT_CODE
