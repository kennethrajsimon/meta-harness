#!/usr/bin/env bash
# log-agent-activity.sh — Append a JSONL activity entry for an agent
# Usage: ./log-agent-activity.sh <agent-name> <status> <"task description"> [model]
# Example: ./log-agent-activity.sh backend active "Building user auth endpoints" sonnet
#
# Status values: active, complete, idle, error, awaiting_orders
# Model values: opus, sonnet, haiku (defaults to sonnet)

set -euo pipefail

if [ $# -lt 3 ]; then
  echo "Usage: $0 <agent-name> <status> <task-description> [model]" >&2
  echo "  agent-name:  Any agent name (auto-discovered from .claude/agents/*.md)" >&2
  echo "  status:      One of: active, complete, idle, error, awaiting_orders" >&2
  echo "  task:        Description string (quote it)" >&2
  echo "  model:       Optional: opus, sonnet, haiku (default: sonnet)" >&2
  exit 1
fi

AGENT="$1"
STATUS="$2"
TASK="$3"
MODEL="${4:-sonnet}"

VALID_STATUSES="active complete idle error awaiting_orders stale"

# Agent names are not whitelisted — any name is accepted (auto-discovered by bridge)
if [ -z "$AGENT" ]; then
  echo "Error: Agent name cannot be empty" >&2
  exit 1
fi

if ! echo "$VALID_STATUSES" | grep -qw "$STATUS"; then
  echo "Error: Invalid status '$STATUS'. Must be one of: $VALID_STATUSES" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
LOG_FILE="$PROJECT_ROOT/.claude/agent-activity.log"

mkdir -p "$(dirname "$LOG_FILE")"

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")

# Escape special JSON characters in task description
TASK_ESCAPED=$(printf '%s' "$TASK" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g')

echo "{\"timestamp\":\"$TIMESTAMP\",\"agent\":\"$AGENT\",\"status\":\"$STATUS\",\"task\":\"$TASK_ESCAPED\",\"model\":\"$MODEL\"}" >> "$LOG_FILE"
