// Write-through to the existing Fleet command queue
// (.claude/agent-commands.json). Atomic tmp-rename writes so concurrent
// writers never see a truncated file — matches the pattern in
// .fleet/agent-bridge.js writeCommand().

const fs = require('fs');
const path = require('path');

const CLAUDE_DIR = path.resolve(__dirname, '..', '..', '..', '.claude');
const CMD_FILE = path.join(CLAUDE_DIR, 'agent-commands.json');

function readAll() {
  if (!fs.existsSync(CMD_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CMD_FILE, 'utf8')); } catch { return []; }
}

function writeAll(arr) {
  const tmp = CMD_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, CMD_FILE);
}

function append(entry) {
  const list = readAll();
  list.push(entry);
  writeAll(list);
}

function enqueue({ agent, text, priority = 'high', missionId, nodeId, leaseId }) {
  const entry = {
    id: 'mh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    target: agent,
    text,
    priority,
    timestamp: new Date().toISOString(),
    source: 'meta-harness',
    acknowledged: false,
    meta: { missionId, nodeId, leaseId }
  };
  append(entry);
  return entry;
}

module.exports = { enqueue, readAll, writeAll, CMD_FILE };
