#!/usr/bin/env bash
# write-agent-command.sh — Write a command to the agent command queue
# Usage: ./write-agent-command.sh <target> <"command text"> [priority]
# Example: ./write-agent-command.sh backend "Refactor auth module to use JWT" high
#
# Target: agent name or "all" to broadcast
# Priority: low, normal, high, critical (default: normal)

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <target> <command-text> [priority]" >&2
  echo "  target:   Any agent name or 'all' for broadcast" >&2
  echo "  command:  Command text (quote it)" >&2
  echo "  priority: Optional: low, normal, high, critical (default: normal)" >&2
  exit 1
fi

TARGET="$1"
TEXT="$2"
PRIORITY="${3:-normal}"

VALID_PRIORITIES="low normal high critical"

# Target names are not whitelisted — any agent name or "all" is accepted
if [ -z "$TARGET" ]; then
  echo "Error: Target cannot be empty" >&2
  exit 1
fi

if ! echo "$VALID_PRIORITIES" | grep -qw "$PRIORITY"; then
  echo "Error: Invalid priority '$PRIORITY'. Must be one of: $VALID_PRIORITIES" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
CMD_FILE="$PROJECT_ROOT/.claude/agent-commands.json"

mkdir -p "$(dirname "$CMD_FILE")"

if [ ! -f "$CMD_FILE" ]; then
  echo "[]" > "$CMD_FILE"
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
ID="cmd_$(date +%s)_$$"

TEXT_ESCAPED=$(printf '%s' "$TEXT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g')

TMP_FILE="$CMD_FILE.tmp"

# Use node if available for proper JSON manipulation, otherwise use a simpler approach
if command -v node &>/dev/null; then
  export _CMD_FILE="$CMD_FILE"
  export _TMP_FILE="$TMP_FILE"
  export _ID="$ID"
  export _TARGET="$TARGET"
  export _TEXT="$TEXT"
  export _PRIORITY="$PRIORITY"
  export _TIMESTAMP="$TIMESTAMP"
  node -e '
    const fs = require("fs");
    const cmds = JSON.parse(fs.readFileSync(process.env._CMD_FILE, "utf8"));
    cmds.push({
      id: process.env._ID,
      target: process.env._TARGET,
      text: process.env._TEXT,
      priority: process.env._PRIORITY,
      timestamp: process.env._TIMESTAMP,
      source: "operator",
      acknowledged: false
    });
    fs.writeFileSync(process.env._TMP_FILE, JSON.stringify(cmds, null, 2));
  '
else
  # Fallback: simple sed-based JSON array append
  # Remove trailing ] and add new entry
  head -c -2 "$CMD_FILE" > "$TMP_FILE" 2>/dev/null || echo "[" > "$TMP_FILE"

  # Add comma if not empty array
  if [ "$(wc -c < "$CMD_FILE")" -gt 3 ]; then
    echo "," >> "$TMP_FILE"
  fi

  cat >> "$TMP_FILE" << ENTRY
  {
    "id": "$ID",
    "target": "$TARGET",
    "text": "$TEXT_ESCAPED",
    "priority": "$PRIORITY",
    "timestamp": "$TIMESTAMP",
    "source": "operator",
    "acknowledged": false
  }
]
ENTRY
fi

mv "$TMP_FILE" "$CMD_FILE"
echo "Command $ID queued for $TARGET (priority: $PRIORITY)"
