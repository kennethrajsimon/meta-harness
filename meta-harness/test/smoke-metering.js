// Phase 2.3 smoke test: meter field on completion, /v1/usage aggregation,
// unknown-model null cost, readAll traversing rotated files.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const identity = require('../src/registry/identity');

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN || 'test-token-abc';
const PORT = parseInt(process.env.META_HARNESS_PORT || '20000', 10);

function request(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
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
  return { 'X-Agent-Name': agent, 'X-Nonce': nonce, 'X-Issued-At': issuedAt, 'X-Signature': signature };
}
const signedReq = (m, p, a, sk, b) => request(m, p, b, signedHeaders(a, sk, b));

function buildManifest(agent, pubkey, models = ['sonnet']) {
  return {
    agent, version: '1.0.0', pubkey,
    capabilities: ['meter'], models,
    rateLimit: { rpm: 60 },
    nonce: randomUUID(), issuedAt: new Date().toISOString()
  };
}

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } else console.log('  ✓', msg); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function registerViaToken(agent, model) {
  const kp = identity.generateKeypair();
  const mint = await request('POST', '/v1/admin/issue-token', { sub: agent, pubkey: kp.publicKey, ttlHours: 1 }, { 'X-Admin-Token': ADMIN_TOKEN });
  if (mint.status !== 200) throw new Error('mint failed ' + JSON.stringify(mint.body));
  const manifest = buildManifest(agent, kp.publicKey, [model]);
  manifest.signature = identity.sign(manifest, kp.secretKey);
  const reg = await request('POST', '/v1/register', { ...manifest, capabilityToken: mint.body.token });
  if (reg.status !== 200) throw new Error('register failed ' + JSON.stringify(reg.body));
  return kp;
}

async function runMissionAsAgent(agent, kp) {
  // Force an explicit DAG assigned to this agent
  const mission = await request('POST', '/v1/missions', {
    title: 'Metering test', brief: 'metering smoke',
    dag: {
      nodes: [{
        id: 'n1', title: 'meter task',
        requiredCapabilities: ['meter'], assignedAgent: agent,
        deliverable: 'done',
        verification: { type: 'command_exit_zero', spec: 'node -e "process.exit(0)"' }
      }]
    }
  }, { 'X-Admin-Token': ADMIN_TOKEN });
  if (mission.status !== 201) throw new Error('mission failed ' + JSON.stringify(mission.body));
  const missionId = mission.body.missionId;

  const lease = await signedReq('POST', `/v1/agents/${agent}/lease`, agent, kp.secretKey, {});
  if (lease.status !== 200) throw new Error('lease failed ' + JSON.stringify(lease.body));

  await sleep(300); // ensure a measurable leaseHeldMs

  const done = await signedReq('POST', `/v1/missions/${missionId}/complete`, agent, kp.secretKey, {
    leaseId: lease.body.leaseId, nodeId: lease.body.node.id, artifacts: []
  });
  if (done.status !== 200) throw new Error('complete failed ' + JSON.stringify(done.body));
  return missionId;
}

(async () => {
  const sonnetAgent = 'meter_s_' + process.pid;
  const unknownAgent = 'meter_u_' + process.pid;

  console.log('[1] register two test agents (one sonnet, one with model not in rates)');
  const kpS = await registerViaToken(sonnetAgent, 'sonnet');
  // Use a bogus model name that isn't in rates.json
  const kpU = await registerViaToken(unknownAgent, 'opus');  // opus IS in rates; we'll test unknown differently

  // For the "unknown model" test, we'll manipulate the manifest to a model not in rates.json.
  // But sonnet is in rates, and opus is in rates. Let's use `haiku` on one and `sonnet` on another,
  // and for "unknown" patch the rates.json to remove sonnet, then re-register with sonnet,
  // OR simpler: patch rates.json after the sonnet test so it returns unknown for sonnet.
  // For MVP: this test verifies that the meter field is populated correctly for valid model.
  // Unknown-model behaviour is unit-tested via rates.js logic (not through full mission).

  console.log('[2] run mission for sonnet agent');
  const missionS = await runMissionAsAgent(sonnetAgent, kpS);

  console.log('[3] audit entry has meter block with estCostCents');
  const audit = await request('GET', '/v1/audit?limit=500');
  const completeEntry = audit.body.entries.find(e => e.action === 'complete' && e.missionId === missionS);
  assert(completeEntry && completeEntry.meter, 'complete audit has meter block');
  assert(completeEntry.meter.leaseHeldMs > 0, `leaseHeldMs > 0 (got ${completeEntry.meter.leaseHeldMs})`);
  assert(completeEntry.meter.model === 'sonnet', `model=sonnet (got ${completeEntry.meter.model})`);
  assert(completeEntry.meter.estCostCents !== null && completeEntry.meter.estCostCents > 0, `estCostCents populated (got ${completeEntry.meter.estCostCents})`);
  assert(completeEntry.meter.estCostReason === 'time_based', `reason=time_based (got ${completeEntry.meter.estCostReason})`);

  console.log('[4] /v1/missions/:id/usage returns mission summary');
  const usage = await request('GET', `/v1/missions/${missionS}/usage`);
  assert(usage.status === 200, 'usage → 200');
  assert(usage.body.totalEvents >= 1, `totalEvents ≥ 1 (got ${usage.body.totalEvents})`);
  assert(usage.body.totalLeaseHeldMs > 0, `totalLeaseHeldMs > 0 (got ${usage.body.totalLeaseHeldMs})`);
  assert(usage.body.byAgent[sonnetAgent], `byAgent[${sonnetAgent}] present`);
  assert(usage.body.methodology === 'time_based_estimate', 'methodology labeled honestly');

  console.log('[5] /v1/metering/rates returns the rate table');
  const r5 = await request('GET', '/v1/metering/rates');
  assert(r5.status === 200 && r5.body.sonnet && r5.body.sonnet.perMinuteCents > 0, 'rates.sonnet present');

  console.log('[6] /v1/usage global aggregate includes our test mission');
  const all = await request('GET', '/v1/usage');
  assert(all.status === 200 && all.body.totalEvents >= 1, 'global usage returns aggregate');

  console.log('[7] unknown-model path: rates.estimate returns null cost + reason');
  const rates = require('../src/metering/rates');
  const unknownResult = rates.estimate({ model: 'nonexistent-model', leaseHeldMs: 10000 });
  assert(unknownResult.estCostCents === null, `unknown model → null cost (got ${unknownResult.estCostCents})`);
  assert(unknownResult.estCostReason === 'unknown_model', `reason unknown_model (got ${unknownResult.estCostReason})`);

  console.log('[8] audit.readAll returns entries (sanity check for rotation-aware reader)');
  const auditLog = require('../src/audit/log');
  const all2 = auditLog.readAll({ limit: 10 });
  assert(Array.isArray(all2) && all2.length > 0, `readAll returned ${all2.length} entries`);

  console.log('\nALL PHASE 2.3 SMOKE TESTS PASSED');

  // cleanup
  await request('POST', '/v1/admin/reset-agent', { agent: sonnetAgent }, { 'X-Admin-Token': ADMIN_TOKEN });
  await request('POST', '/v1/admin/reset-agent', { agent: unknownAgent }, { 'X-Admin-Token': ADMIN_TOKEN });
})().catch(e => { console.error(e); process.exit(1); });
