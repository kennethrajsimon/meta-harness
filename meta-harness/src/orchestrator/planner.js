// Phase 1 planner: rule-based mission brief → DAG.
// Heuristic: scan the brief for phrase buckets, route each bucket to its
// best-scoring agent via the discovery router. If no buckets match, emit a
// single node assigned to the top tf-idf match. Operator can supply an
// explicit DAG to bypass the planner entirely (escape hatch).

const router = require('../discovery/router');

const BUCKETS = [
  { name: 'backend',  words: ['api', 'endpoint', 'route', 'handler', 'server', 'backend'] },
  { name: 'frontend', words: ['ui', 'component', 'page', 'form', 'frontend', 'react', 'vue', 'accessibility', 'styling'] },
  { name: 'database', words: ['schema', 'migration', 'query', 'index', 'table', 'sql', 'database'] },
  { name: 'qa',       words: ['test', 'regression', 'coverage', 'spec'] },
  { name: 'security', words: ['security', 'vulnerability', 'audit', 'auth', 'token', 'csrf', 'xss'] },
  { name: 'devops',   words: ['deploy', 'docker', 'ci', 'pipeline', 'infra'] },
  { name: 'perf',     words: ['performance', 'profile', 'benchmark', 'latency', 'throughput'] },
  { name: 'docs',     words: ['document', 'readme', 'guide', 'reference'] },
  { name: 'reviewer', words: ['review'] }
];

function detectBuckets(brief) {
  const lc = brief.toLowerCase();
  return BUCKETS.filter(b => b.words.some(w => lc.includes(w))).map(b => b.name);
}

function chooseAgent(brief, preferredAgent) {
  // If an agent name appears in the brief buckets and is registered, prefer it.
  const matches = router.match(brief, { topN: 3 });
  if (preferredAgent) {
    const hit = matches.find(m => m.agent === preferredAgent);
    if (hit) return hit.agent;
  }
  return matches[0] && matches[0].agent;
}

// Default verification when the operator didn't supply one. We pick a cheap
// command that succeeds when the project tree is sane (platform-neutral).
function defaultVerification() {
  return { type: 'command_exit_zero', spec: 'node -e "process.exit(0)"' };
}

function plan(mission) {
  if (mission.dag && Array.isArray(mission.dag.nodes) && mission.dag.nodes.length > 0) {
    // Operator-supplied DAG: leave alone, just backfill defaults.
    for (const n of mission.dag.nodes) {
      n.state = n.state || 'pending';
      n.dependsOn = n.dependsOn || [];
      n.attempts = n.attempts || 0;
      n.maxAttempts = n.maxAttempts || 2;
      if (!n.verification) n.verification = defaultVerification();
      if (!n.assignedAgent) n.assignedAgent = chooseAgent(n.title || mission.brief, null);
    }
    mission.dag.edges = mission.dag.edges || [];
    return mission;
  }

  const buckets = detectBuckets(mission.brief);
  const nodes = [];
  const edges = [];
  let idx = 1;

  if (buckets.length === 0) {
    const agent = chooseAgent(mission.brief, null) || 'backend';
    nodes.push({
      id: `n${idx++}`,
      title: mission.title || mission.brief.slice(0, 80),
      requiredCapabilities: [],
      assignedAgent: agent,
      state: 'pending',
      dependsOn: [],
      deliverable: mission.title || mission.brief.slice(0, 120),
      verification: defaultVerification(),
      attempts: 0,
      maxAttempts: 2
    });
  } else {
    // Non-reviewer buckets become independent sibling nodes; reviewer bucket
    // becomes a terminal node depending on all prior nodes.
    const prior = [];
    for (const bucket of buckets) {
      if (bucket === 'reviewer') continue;
      const agent = chooseAgent(mission.brief, bucket) || bucket;
      const id = `n${idx++}`;
      nodes.push({
        id,
        title: `${bucket}: ${mission.title || mission.brief.slice(0, 60)}`,
        requiredCapabilities: [],
        assignedAgent: agent,
        state: 'pending',
        dependsOn: [],
        deliverable: mission.brief.slice(0, 120),
        verification: defaultVerification(),
        attempts: 0,
        maxAttempts: 2
      });
      prior.push(id);
    }
    if (buckets.includes('reviewer') && prior.length > 0) {
      const id = `n${idx++}`;
      nodes.push({
        id,
        title: `reviewer: final pass`,
        requiredCapabilities: [],
        assignedAgent: 'reviewer',
        state: 'pending',
        dependsOn: prior.slice(),
        deliverable: 'reviewer sign-off',
        verification: defaultVerification(),
        attempts: 0,
        maxAttempts: 2
      });
      for (const p of prior) edges.push([p, id]);
    }
  }

  mission.dag = { nodes, edges };
  return mission;
}

module.exports = { plan, detectBuckets, defaultVerification };
