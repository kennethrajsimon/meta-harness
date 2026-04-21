// Counters + gauges for the Meta Harness.
//
// Counters accumulate monotonically; gauges reflect current state.
// Event subscriptions mutate counters as they fire; gauges are computed
// on-demand from live state (registry, missions, killswitch). Only
// counters are persisted via checkpoint so restarts preserve totals.

const counters = new Map();   // key = "name|labels" → number
const start = Date.now();

function labelKey(name, labels) {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.keys(labels).sort().map(k => `${k}="${labels[k]}"`).join(',');
  return `${name}{${sorted}}`;
}

function incCounter(name, labels, delta = 1) {
  const k = labelKey(name, labels);
  counters.set(k, (counters.get(k) || 0) + delta);
}

function snapshot() {
  const registryStore = require('../registry/store');
  const killswitch = require('../safety/killswitch');
  const missionStore = require('../orchestrator/missionStore');

  const agents = registryStore.list();
  const missions = missionStore.list();

  const agentsInflight = {};
  for (const a of agents) agentsInflight[a.agent] = a.inflight || 0;

  const gauges = {
    mh_agents_registered: agents.length,
    mh_killswitch_active: killswitch.isHalted() ? 1 : 0,
    mh_missions_running: missions.filter(m => m.status === 'running').length,
    mh_process_start_ts: Math.floor(start / 1000),
    mh_agents_inflight: agentsInflight,
  };
  // Peers gauge resolved lazily (federation module may not be loaded yet)
  try {
    const peers = require('../federation/peers').list();
    gauges.mh_peers_connected = peers.length;
  } catch { gauges.mh_peers_connected = 0; }

  return {
    counters: Object.fromEntries(counters),
    gauges,
    generatedAt: new Date().toISOString(),
    uptimeMs: Date.now() - start
  };
}

// Restore counters from a checkpoint (does not touch gauges).
function restoreCounters(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') counters.set(k, v);
  }
}

// ─── Wire counters to events.broadcast ──────────────────────────────────
// We only observe events.broadcast — gauges are derived from live state and
// need no subscription.

function attach(events) {
  const original = events.broadcast;
  events.broadcast = function (type, data) {
    try {
      switch (type) {
        case 'mission_created':
          incCounter('mh_missions_created_total');
          break;
        case 'mission_completed':
          incCounter('mh_missions_total', { status: String(data && data.status || 'unknown') });
          break;
        case 'mission_cancelled':
          incCounter('mh_missions_total', { status: 'cancelled' });
          break;
        case 'lease_issued':
          incCounter('mh_leases_total', { agent: String(data && data.agent || 'unknown') });
          break;
        case 'lease_expired':
          incCounter('mh_lease_expirations_total', { agent: String(data && data.agent || 'unknown') });
          break;
        case 'agent_registered': {
          const path = String(data && data.authPath || 'unknown');
          incCounter('mh_registrations_total', { result: path });
          break;
        }
        case 'node_failed':
          incCounter('mh_node_failures_total', { agent: String(data && data.agent || 'unknown') });
          break;
        case 'agent_pubkey_rotated':
          incCounter('mh_pubkey_rotations_total');
          break;
      }
    } catch { /* must never break fanout */ }
    return original.call(events, type, data);
  };
}

module.exports = { attach, snapshot, incCounter, restoreCounters };
