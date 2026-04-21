// Dashboard projection: every interesting Meta Harness event is mirrored
// into .claude/agent-activity.log so the existing Fleet Command 3D
// dashboard renders Meta Harness activity without being coupled to us.
//
// Writes go through .fleet/log-agent-activity.sh when available (so the
// Fleet bridge's fs.watch sees a normal append), with a direct JSONL
// append as a fallback if the script path resolves incorrectly.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOG_SCRIPT = path.resolve(__dirname, '..', '..', '..', '.fleet', 'log-agent-activity.sh');
const LOG_FILE = path.resolve(__dirname, '..', '..', '..', '.claude', 'agent-activity.log');

const HAS_SCRIPT = fs.existsSync(LOG_SCRIPT);

function directAppend(agent, status, task, model) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    agent, status, task, model: model || 'system'
  }) + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* best effort */ }
}

function log(agent, status, task, model = 'system') {
  const safeTask = String(task || '').slice(0, 500);
  if (HAS_SCRIPT) {
    try {
      const r = spawnSync('bash', [LOG_SCRIPT, agent, status, safeTask, model], { timeout: 2000 });
      if (r.status === 0) return;
    } catch { /* fall through */ }
  }
  directAppend(agent, status, safeTask, model);
}

// Hook the Meta Harness events fanout: for every broadcast type we translate
// to an activity log entry with a meaningful agent name.
function attach(events) {
  const original = events.broadcast;
  events.broadcast = function (type, data) {
    try {
      switch (type) {
        case 'mission_created':
          log('meta-harness', 'active', `mission ${data.missionId} created: ${data.title}`);
          break;
        case 'lease_issued':
          log('meta-harness', 'active', `lease ${data.leaseId} → ${data.agent} (${data.missionId}/${data.nodeId})`);
          break;
        case 'progress':
          log('meta-harness', 'active', `progress ${data.agent} ${data.missionId}/${data.nodeId} ${data.pct || ''}%`);
          break;
        case 'node_done':
          log('meta-harness', 'active', `node done ${data.agent} ${data.missionId}/${data.nodeId}`);
          break;
        case 'node_failed':
          log('meta-harness', 'error', `node failed ${data.agent} ${data.missionId}/${data.nodeId} — ${data.detail || ''}`);
          break;
        case 'node_retry':
          log('meta-harness', 'active', `node retry ${data.agent} ${data.missionId}/${data.nodeId}`);
          break;
        case 'mission_completed':
          log('meta-harness', 'complete', `mission ${data.missionId} → ${data.status}`);
          break;
        case 'mission_cancelled':
          log('meta-harness', 'complete', `mission ${data.missionId} cancelled`);
          break;
        case 'halted':
          log('meta-harness', 'awaiting_orders', `HALTED — ${data.reason || 'no reason'}`);
          break;
        case 'resumed':
          log('meta-harness', 'active', 'resumed');
          break;
        case 'lease_expired':
          log('meta-harness', 'error', `lease expired ${data.missionId}/${data.nodeId} (${data.agent})`);
          break;
        case 'agent_registered':
          log('meta-harness', 'active', `registered ${data.agent}`);
          break;
        case 'agent_reset':
          log('meta-harness', 'awaiting_orders', `reset ${data.agent}`);
          break;
      }
    } catch { /* projection must not break fanout */ }
    return original.call(events, type, data);
  };
}

module.exports = { attach, log };
