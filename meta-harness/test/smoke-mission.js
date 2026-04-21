// End-to-end smoke test through Phases 1b..1e:
// 1. Fresh DB (clean data/registry/ and data/missions/ before run)
// 2. Register "backend" agent with signed manifest
// 3. Submit mission "Add /v1/health endpoint" (no explicit DAG → planner fills)
// 4. Backend long-polls lease → receives node
// 5. Backend sends progress
// 6. Backend completes node → verification runs → mission completed
// 7. Audit trail covers register → mission_created → lease → progress → complete → mission_completed
// 8. Halt + resume + cancel round-trips
//
// Requires meta-harness running with META_HARNESS_ADMIN_TOKEN=test-token-abc

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const identity = require('../src/registry/identity');

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN || 'test-token-abc';
const PORT = parseInt(process.env.META_HARNESS_PORT || '20000', 10);

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

function signedHeaders(agent, secretKey, body) {
  const nonce = randomUUID();
  const issuedAt = new Date().toISOString();
  const signed = { ...(body || {}), _meta: { agent, nonce, issuedAt } };
  const signature = identity.sign(signed, secretKey);
  return {
    'X-Agent-Name': agent,
    'X-Nonce': nonce,
    'X-Issued-At': issuedAt,
    'X-Signature': signature
  };
}

async function signedRequest(method, url, agent, secretKey, body) {
  return request(method, url, body, signedHeaders(agent, secretKey, body));
}

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } else console.log('  ✓', msg); }

// Use a unique test-agent name so we don't clobber the real broker's
// TOFU pin for `backend` etc. No state wipe — tests are state-additive.
const TEST_AGENT = 'mtest_' + process.pid;

(async () => {
  console.log(`[setup] using isolated test agent: ${TEST_AGENT}`);

  console.log('\n[1] register test agent');
  const kp = identity.generateKeypair();
  const manifestBody = {
    agent: TEST_AGENT,
    version: '1.0.0',
    pubkey: kp.publicKey,
    capabilities: ['smoketest', 'endpoint', 'route', 'api', 'backend-like'],
    models: ['sonnet'],
    rateLimit: { rpm: 60 },
    nonce: randomUUID(),
    issuedAt: new Date().toISOString()
  };
  const signature = identity.sign(manifestBody, kp.secretKey);
  const r1 = await request('POST', '/v1/register', { ...manifestBody, signature }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(r1.status === 200, `register → 200 (got ${r1.status} ${JSON.stringify(r1.body)})`);

  console.log('\n[2] submit mission with explicit DAG targeting test agent');
  const r2 = await request('POST', '/v1/missions', {
    title: 'Smoke mission',
    brief: 'Smoke test for the orchestration round-trip',
    dag: {
      nodes: [{
        id: 'n1',
        title: 'Smoke task',
        requiredCapabilities: ['smoketest'],
        assignedAgent: TEST_AGENT,
        deliverable: 'smoke',
        verification: { type: 'command_exit_zero', spec: 'node -e "process.exit(0)"' }
      }]
    }
  }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(r2.status === 201, `mission → 201 (got ${r2.status} ${JSON.stringify(r2.body)})`);
  const missionId = r2.body.missionId;
  assert(missionId, 'missionId present');
  const nodes = r2.body.mission.dag.nodes;
  assert(nodes.length >= 1, 'at least one DAG node');
  assert(nodes[0].assignedAgent === TEST_AGENT, `first node assigned to ${TEST_AGENT} (got ${nodes[0].assignedAgent})`);

  console.log('\n[3] test agent long-polls its lease endpoint');
  const r3 = await signedRequest('POST', `/v1/agents/${TEST_AGENT}/lease`, TEST_AGENT, kp.secretKey, {});
  assert(r3.status === 200, `lease → 200 (got ${r3.status} ${JSON.stringify(r3.body)})`);
  const leaseId = r3.body.leaseId;
  const nodeId = r3.body.node.id;
  assert(leaseId && nodeId, 'leaseId + nodeId returned');

  console.log('\n[4] test agent sends progress');
  const r4 = await signedRequest('POST', `/v1/missions/${missionId}/progress`, TEST_AGENT, kp.secretKey, { leaseId, nodeId, pct: 50, note: 'halfway' });
  assert(r4.status === 200, `progress → 200 (got ${r4.status})`);

  console.log('\n[5] test agent completes node (command_exit_zero)');
  const r5 = await signedRequest('POST', `/v1/missions/${missionId}/complete`, TEST_AGENT, kp.secretKey, { leaseId, nodeId, artifacts: [{ kind: 'text', ref: 'done' }] });
  assert(r5.status === 200, `complete → 200 (got ${r5.status} ${JSON.stringify(r5.body)})`);

  console.log('\n[6] mission is now completed');
  const r6 = await request('GET', `/v1/missions/${missionId}`);
  assert(r6.body.status === 'completed', `status=completed (got ${r6.body.status})`);

  console.log('\n[7] audit trail contains all expected actions');
  const r7 = await request('GET', `/v1/audit?limit=500`);
  const actions = r7.body.entries.map(e => e.action);
  for (const needed of ['register', 'mission_created', 'lease', 'progress', 'complete']) {
    assert(actions.includes(needed), `audit includes ${needed}`);
  }

  console.log('\n[8] halt → new mission rejected → resume');
  const r8a = await request('POST', '/v1/halt', { reason: 'smoke test' }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(r8a.status === 200 && r8a.body.halted === true, 'halt → 200 halted=true');
  const r8b = await request('POST', '/v1/missions', { title: 'should fail', brief: 'nope' }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(r8b.status === 503, `mission during halt → 503 (got ${r8b.status})`);
  const r8c = await request('POST', '/v1/resume', {}, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(r8c.status === 200, 'resume → 200');

  console.log('\n[9] submit + cancel mission');
  const r9a = await request('POST', '/v1/missions', { title: 'X', brief: 'build endpoint for X' }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(r9a.status === 201, 'mission #2 created');
  const r9b = await request('POST', `/v1/missions/${r9a.body.missionId}/cancel`, {}, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(r9b.status === 200 && r9b.body.status === 'cancelled', 'cancel → 200 status=cancelled');

  console.log('\n[10] clean up test agent');
  await request('POST', '/v1/admin/reset-agent', { agent: TEST_AGENT }, { 'X-Admin-Token': ADMIN_TOKEN });

  console.log('\nALL PHASE 1b..1e SMOKE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
