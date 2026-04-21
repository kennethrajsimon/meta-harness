// Scheduler: computes ready-set and cascades failures.
// Concurrency is enforced at the route layer via registry.inflight.

function computeReady(mission) {
  const byId = new Map();
  for (const n of mission.dag.nodes) byId.set(n.id, n);
  let changed = false;
  for (const n of mission.dag.nodes) {
    if (n.state !== 'pending') continue;
    const deps = n.dependsOn || [];
    const allDone = deps.every(d => {
      const dep = byId.get(d);
      return dep && dep.state === 'done';
    });
    const anyFailed = deps.some(d => {
      const dep = byId.get(d);
      return dep && (dep.state === 'failed' || dep.state === 'skipped');
    });
    if (anyFailed) { n.state = 'skipped'; changed = true; continue; }
    if (allDone) { n.state = 'ready'; changed = true; }
  }
  return changed;
}

function cascadeFailure(mission, failedNodeId) {
  const byId = new Map();
  for (const n of mission.dag.nodes) byId.set(n.id, n);
  const stack = [failedNodeId];
  while (stack.length) {
    const id = stack.pop();
    for (const n of mission.dag.nodes) {
      if ((n.dependsOn || []).includes(id) && n.state !== 'skipped' && n.state !== 'failed') {
        n.state = 'skipped';
        stack.push(n.id);
      }
    }
  }
}

function recomputeMissionStatus(mission) {
  const states = mission.dag.nodes.map(n => n.state);
  if (states.some(s => s === 'in_progress' || s === 'leased' || s === 'ready' || s === 'pending')) {
    mission.status = 'running';
    return;
  }
  const failed = states.filter(s => s === 'failed').length;
  const skipped = states.filter(s => s === 'skipped').length;
  if (failed === 0 && skipped === 0) mission.status = 'completed';
  else if (states.some(s => s === 'done')) mission.status = 'partial_failure';
  else mission.status = 'failed';
}

// Pick the next ready node assignable to `agent`, honoring optional mission
// filtering (kill-switch excludes all missions by returning an empty list).
function pickNextForAgent(missions, agent) {
  for (const mission of missions) {
    if (mission.status !== 'running') continue;
    for (const node of mission.dag.nodes) {
      if (node.state !== 'ready') continue;
      if (node.assignedAgent && node.assignedAgent !== agent) continue;
      return { mission, node };
    }
  }
  return null;
}

module.exports = { computeReady, cascadeFailure, recomputeMissionStatus, pickNextForAgent };
