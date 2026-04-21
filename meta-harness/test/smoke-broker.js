// Phase 1f smoke test: verify the broker bridges fleet log → Meta Harness.
// Assumes meta-harness is running on :20000 with admin token, and that the
// broker is running alongside (and has registered .claude/agents/*.md).
//
// Flow:
//   1. Submit mission targeting "backend"
//   2. Wait for broker to receive a lease + write a command into
//      .claude/agent-commands.json containing meta.missionId.
//   3. Simulate the agent by calling .fleet/log-agent-activity.sh:
//      log `active` then `complete` — the broker should see these and call
//      /v1/missions/:id/progress then /v1/missions/:id/complete.
//   4. Poll /v1/missions/:id until status=completed.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN || 'test-token-abc';
const PORT = parseInt(process.env.META_HARNESS_PORT || '20000', 10);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } else console.log('  ✓', msg); }

function logActivity(agent, status, task, model) {
  const script = path.join(PROJECT_ROOT, '.fleet', 'log-agent-activity.sh');
  const r = spawnSync('bash', [script, agent, status, task, model || 'sonnet'], { cwd: PROJECT_ROOT });
  if (r.status !== 0) throw new Error('log-agent-activity.sh failed: ' + r.stderr.toString());
}

function readCommandQueue() {
  const f = path.join(PROJECT_ROOT, '.claude', 'agent-commands.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

(async () => {
  console.log('[1] submit mission targeting backend');
  const m = await request('POST', '/v1/missions', {
    title: 'Broker smoke test',
    brief: 'Create a backend endpoint that handles health-check requests'
  }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(m.status === 201, `mission created (got ${m.status} ${JSON.stringify(m.body)})`);
  const missionId = m.body.missionId;

  console.log('[2] wait up to 10s for broker to queue a command with our missionId');
  let cmd = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const q = readCommandQueue();
    cmd = q.reverse().find(c => c.meta && c.meta.missionId === missionId);
    if (cmd) break;
  }
  assert(cmd, `command queued by broker (target=${cmd && cmd.target})`);
  assert(cmd.target === 'backend', `command targets backend`);
  assert(cmd.meta && cmd.meta.leaseId, 'command carries leaseId');

  console.log('[3] simulate backend agent: log active then complete via .fleet/log-agent-activity.sh');
  logActivity('backend', 'active', `Executing: ${cmd.text.slice(0, 80)}`, 'sonnet');
  await sleep(800);
  logActivity('backend', 'complete', `Completed: ${cmd.text.slice(0, 80)}`, 'sonnet');

  console.log('[4] poll /v1/missions/:id until status changes to completed (up to 15s)');
  let finalStatus = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const r = await request('GET', `/v1/missions/${missionId}`);
    if (r.body && (r.body.status === 'completed' || r.body.status === 'partial_failure' || r.body.status === 'failed')) {
      finalStatus = r.body.status;
      break;
    }
  }
  assert(finalStatus === 'completed', `mission reached completed (got ${finalStatus})`);

  console.log('[5] audit trail contains broker-driven actions');
  const a = await request('GET', '/v1/audit?limit=500');
  const actions = new Set(a.body.entries.map(e => e.action));
  for (const needed of ['lease', 'progress', 'complete']) {
    assert(actions.has(needed), `audit includes ${needed}`);
  }

  console.log('\nALL PHASE 1f SMOKE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
