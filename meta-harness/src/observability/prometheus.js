// Serialize a metrics snapshot to Prometheus text format. Deliberately
// minimal — no HELP/TYPE metadata lookups; we emit HELP/TYPE inline based
// on well-known prefixes. Good enough for scraping + human eyes.

const DESC = {
  mh_missions_created_total: ['counter', 'Missions submitted to the Meta Harness'],
  mh_missions_total: ['counter', 'Missions reaching a terminal state'],
  mh_leases_total: ['counter', 'Leases issued per agent'],
  mh_lease_expirations_total: ['counter', 'Leases that expired without completion'],
  mh_registrations_total: ['counter', 'Agent registrations by auth path'],
  mh_node_failures_total: ['counter', 'DAG node final failures'],
  mh_pubkey_rotations_total: ['counter', 'Pubkey rotations via capability token'],
  mh_agents_registered: ['gauge', 'Currently registered agents'],
  mh_agents_inflight: ['gauge', 'Active leases per agent'],
  mh_killswitch_active: ['gauge', 'Killswitch state (1=halted)'],
  mh_missions_running: ['gauge', 'Missions currently running'],
  mh_peers_connected: ['gauge', 'Connected federation peers'],
  mh_process_start_ts: ['gauge', 'Process start unix timestamp'],
};

function emit(lines, name, labels, value) {
  if (!labels || Object.keys(labels).length === 0) {
    lines.push(`${name} ${value}`);
  } else {
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',');
    lines.push(`${name}{${pairs}} ${value}`);
  }
}

function serialize(snapshot) {
  const lines = [];
  const emitted = new Set();

  function header(name) {
    if (emitted.has(name)) return;
    emitted.add(name);
    const d = DESC[name];
    if (d) {
      lines.push(`# HELP ${name} ${d[1]}`);
      lines.push(`# TYPE ${name} ${d[0]}`);
    }
  }

  // Counters: key is either "name" or "name{labels}"
  for (const [k, v] of Object.entries(snapshot.counters || {})) {
    const m = k.match(/^([a-z_]+)(?:\{(.*)\})?$/i);
    if (!m) continue;
    const name = m[1];
    header(name);
    if (m[2]) {
      lines.push(`${name}{${m[2]}} ${v}`);
    } else {
      lines.push(`${name} ${v}`);
    }
  }

  // Gauges
  const gauges = snapshot.gauges || {};
  for (const [name, v] of Object.entries(gauges)) {
    if (name === 'mh_agents_inflight' && typeof v === 'object') {
      header(name);
      for (const [agent, inflight] of Object.entries(v)) {
        emit(lines, name, { agent }, inflight);
      }
    } else if (typeof v === 'number') {
      header(name);
      emit(lines, name, null, v);
    }
  }

  return lines.join('\n') + '\n';
}

module.exports = { serialize };
