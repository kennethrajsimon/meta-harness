// Phase 1d orchestrator routes:
//   POST /v1/missions                        (admin-gated)
//   GET  /v1/missions                        (public)
//   GET  /v1/missions/:id                    (public)
//   POST /v1/agents/:name/lease              (Ed25519-signed)
//   POST /v1/leases/:leaseId/renew           (Ed25519-signed)
//   POST /v1/missions/:id/progress           (Ed25519-signed)
//   POST /v1/missions/:id/complete           (Ed25519-signed)

const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const fs = require('fs');
const path = require('path');

const missionStore = require('./missionStore');
const leases = require('./leases');
const scheduler = require('./scheduler');
const planner = require('./planner');
const verify = require('./verify');
const sigCheck = require('./sigCheck');
const registry = require('../registry/store');
const audit = require('../audit/log');
const events = require('../ws/events');
const killswitch = require('../safety/killswitch');
const meterRates = require('../metering/rates');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const missionSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'mission.schema.json'), 'utf8'));
const dagNodeSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'dagNode.schema.json'), 'utf8'));
const progressSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'progress.schema.json'), 'utf8'));
ajv.addSchema(dagNodeSchema, 'meta-harness://schemas/dagNode');
const validateMission = ajv.compile(missionSchema);
const validateProgress = ajv.compile(progressSchema);

const MAX_CONCURRENT_PER_AGENT = parseInt(process.env.MAX_CONCURRENT_PER_AGENT || '1', 10);
const LEASE_LONGPOLL_MS = 30 * 1000;
const LEASE_POLL_INTERVAL_MS = 500;

// Lease sweeper: when a lease expires, find the node and return it to `ready`.
leases.startSweeper(expired => {
  const mission = missionStore.load(expired.missionId);
  if (!mission) return;
  const node = mission.dag.nodes.find(n => n.id === expired.nodeId);
  if (!node) return;
  if (node.state === 'leased' || node.state === 'in_progress') {
    node.state = 'ready';
    node.leaseId = null;
    missionStore.save(mission);
    registry.adjustInflight(expired.agent, -1);
    audit.append({ actor: 'system', action: 'lease_expired', missionId: mission.id, nodeId: node.id, detail: { agent: expired.agent } });
    events.broadcast('lease_expired', { missionId: mission.id, nodeId: node.id, agent: expired.agent });
  }
});

function activateReady(mission) {
  scheduler.computeReady(mission);
  scheduler.recomputeMissionStatus(mission);
  missionStore.save(mission);
}

function register(app) {
  // POST /v1/missions
  app.route('POST', '/v1/missions', async (req, res, params, body) => {
    if (killswitch.isHalted()) return app.json(res, 503, { error: 'halted' });
    if (!body || typeof body !== 'object') return app.json(res, 400, { error: 'invalid_body' });
    if (!validateMission(body)) return app.json(res, 400, { error: 'schema_violation', details: validateMission.errors });

    const mission = {
      id: missionStore.newId(),
      title: body.title,
      brief: body.brief,
      autoReplan: !!body.autoReplan,
      createdAt: new Date().toISOString(),
      createdBy: 'operator',
      status: 'planning',
      dag: body.dag || null,
      artifacts: [],
      replanCount: 0
    };

    planner.plan(mission);

    // Validate any operator-supplied DAG nodes against schema.
    const nodeValidate = ajv.compile(dagNodeSchema);
    for (const n of mission.dag.nodes) {
      if (!nodeValidate(n)) return app.json(res, 400, { error: 'dag_node_invalid', details: nodeValidate.errors });
    }

    // Phase 2.4: reject peer-assigned nodes — cross-harness execution is phase 3.
    for (const n of mission.dag.nodes) {
      if (n.assignedAgent && typeof n.assignedAgent === 'string' && n.assignedAgent.startsWith('peer:')) {
        return app.json(res, 501, { error: 'federation_execution_not_implemented', phase: 3, nodeId: n.id, hint: 'discovery only — run the task locally or on the peer directly' });
      }
    }

    mission.status = 'running';
    activateReady(mission);

    audit.append({ actor: 'operator', action: 'mission_created', missionId: mission.id, detail: { title: mission.title, nodes: mission.dag.nodes.length } });
    events.broadcast('mission_created', { missionId: mission.id, title: mission.title, dag: mission.dag });
    app.json(res, 201, { missionId: mission.id, mission });
  }, { adminToken: true });

  // GET /v1/missions
  app.route('GET', '/v1/missions', (req, res) => {
    app.json(res, 200, { missions: missionStore.list() });
  });

  // GET /v1/missions/:id
  app.route('GET', '/v1/missions/:id', (req, res, params) => {
    const m = missionStore.load(params.id);
    if (!m) return app.json(res, 404, { error: 'not_found' });
    app.json(res, 200, m);
  });

  // POST /v1/agents/:name/lease — long-poll up to 30s for a ready node.
  app.route('POST', '/v1/agents/:name/lease', async (req, res, params, body) => {
    if (killswitch.isHalted()) return app.json(res, 503, { error: 'halted' });
    const sig = sigCheck.check(req, body);
    if (!sig.ok) return app.json(res, sig.status, { error: sig.error });
    if (sig.agent !== params.name) return app.json(res, 403, { error: 'agent_mismatch' });

    const rec = registry.load(sig.agent);
    if (rec && (rec.inflight || 0) >= MAX_CONCURRENT_PER_AGENT) {
      return app.json(res, 202, { leaseId: null, reason: 'at_concurrency_limit' });
    }

    const deadline = Date.now() + LEASE_LONGPOLL_MS;
    while (Date.now() < deadline) {
      if (killswitch.isHalted()) return app.json(res, 503, { error: 'halted' });
      const picked = scheduler.pickNextForAgent(missionStore.list(), sig.agent);
      if (picked) {
        const { mission, node } = picked;
        const leaseId = leases.issue({ missionId: mission.id, nodeId: node.id, agent: sig.agent });
        node.state = 'leased';
        node.leaseId = leaseId;
        missionStore.save(mission);
        registry.adjustInflight(sig.agent, +1);
        audit.append({ actor: `agent:${sig.agent}`, action: 'lease', sigOk: true, missionId: mission.id, nodeId: node.id, detail: { leaseId } });
        events.broadcast('lease_issued', { missionId: mission.id, nodeId: node.id, agent: sig.agent, leaseId });
        return app.json(res, 200, { leaseId, ttlMs: leases.DEFAULT_TTL_MS, mission: { id: mission.id, title: mission.title }, node });
      }
      await new Promise(r => setTimeout(r, LEASE_POLL_INTERVAL_MS));
    }
    app.json(res, 204, null);
  });

  // POST /v1/leases/:leaseId/renew
  app.route('POST', '/v1/leases/:leaseId/renew', async (req, res, params, body) => {
    const sig = sigCheck.check(req, body);
    if (!sig.ok) return app.json(res, sig.status, { error: sig.error });
    const l = leases.get(params.leaseId);
    if (!l) return app.json(res, 404, { error: 'lease_not_found' });
    if (l.agent !== sig.agent) return app.json(res, 403, { error: 'lease_agent_mismatch' });
    const renewed = leases.renew(params.leaseId);
    audit.append({ actor: `agent:${sig.agent}`, action: 'lease_renew', sigOk: true, missionId: l.missionId, nodeId: l.nodeId, detail: { leaseId: l.id } });
    app.json(res, 200, { ok: true, expiresAt: new Date(renewed.expiresAt).toISOString() });
  });

  // POST /v1/missions/:id/progress
  app.route('POST', '/v1/missions/:id/progress', async (req, res, params, body) => {
    const sig = sigCheck.check(req, body);
    if (!sig.ok) return app.json(res, sig.status, { error: sig.error });
    if (!validateProgress(body)) return app.json(res, 400, { error: 'schema_violation', details: validateProgress.errors });
    const l = leases.get(body.leaseId);
    if (!l) return app.json(res, 404, { error: 'lease_not_found' });
    if (l.agent !== sig.agent) return app.json(res, 403, { error: 'lease_agent_mismatch' });
    if (l.missionId !== params.id || l.nodeId !== body.nodeId) return app.json(res, 409, { error: 'lease_mismatch' });

    leases.renew(body.leaseId);
    const mission = missionStore.load(params.id);
    if (!mission) return app.json(res, 404, { error: 'mission_not_found' });
    const node = mission.dag.nodes.find(n => n.id === body.nodeId);
    if (node && node.state === 'leased') { node.state = 'in_progress'; missionStore.save(mission); }

    audit.append({ actor: `agent:${sig.agent}`, action: 'progress', sigOk: true, missionId: params.id, nodeId: body.nodeId, detail: { pct: body.pct, note: body.note } });
    events.broadcast('progress', { missionId: params.id, nodeId: body.nodeId, agent: sig.agent, pct: body.pct, note: body.note });
    app.json(res, 200, { ok: true });
  });

  // POST /v1/missions/:id/complete
  app.route('POST', '/v1/missions/:id/complete', async (req, res, params, body) => {
    const sig = sigCheck.check(req, body);
    if (!sig.ok) return app.json(res, sig.status, { error: sig.error });
    if (!body || !body.leaseId || !body.nodeId) return app.json(res, 400, { error: 'missing_fields' });

    const l = leases.get(body.leaseId);
    if (!l) return app.json(res, 404, { error: 'lease_not_found' });
    if (l.agent !== sig.agent) return app.json(res, 403, { error: 'lease_agent_mismatch' });
    if (l.missionId !== params.id || l.nodeId !== body.nodeId) return app.json(res, 409, { error: 'lease_mismatch' });

    const mission = missionStore.load(params.id);
    if (!mission) return app.json(res, 404, { error: 'mission_not_found' });
    const node = mission.dag.nodes.find(n => n.id === body.nodeId);
    if (!node) return app.json(res, 404, { error: 'node_not_found' });

    node.attempts = (node.attempts || 0) + 1;
    const v = await verify.run(node.verification, { missionLoad: missionStore.load });

    // Compute the meter block regardless of verification result — failed
    // work still cost time.
    const leaseStartMs = l.issuedAt || Date.now();
    const leaseEndMs = Date.now();
    const leaseHeldMs = Math.max(0, leaseEndMs - leaseStartMs);
    const agentRecord = registry.load(sig.agent);
    const agentModel = agentRecord && agentRecord.manifest && agentRecord.manifest.models && agentRecord.manifest.models[0];
    const costEstimate = meterRates.estimate({ model: agentModel, leaseHeldMs });
    const meter = {
      leaseStart: new Date(leaseStartMs).toISOString(),
      leaseEnd: new Date(leaseEndMs).toISOString(),
      leaseHeldMs,
      agent: sig.agent,
      model: agentModel || null,
      tokensIn: null,    // populated when Claude CLI exposes usage
      tokensOut: null,
      estCostCents: costEstimate.estCostCents,
      estCostReason: costEstimate.estCostReason
    };

    if (v.ok) {
      node.state = 'done';
      node.leaseId = null;
      if (Array.isArray(body.artifacts)) mission.artifacts.push(...body.artifacts.map(a => ({ nodeId: node.id, ...a })));
      leases.release(body.leaseId);
      registry.adjustInflight(sig.agent, -1);
      activateReady(mission);
      audit.append({ actor: `agent:${sig.agent}`, action: 'complete', sigOk: true, missionId: params.id, nodeId: body.nodeId, meter, detail: { verification: v.detail } });
      events.broadcast('node_done', { missionId: params.id, nodeId: body.nodeId, agent: sig.agent });
      if (mission.status === 'completed' || mission.status === 'partial_failure' || mission.status === 'failed') {
        events.broadcast('mission_completed', { missionId: params.id, status: mission.status });
      }
      return app.json(res, 200, { ok: true, verification: v });
    }

    // Verification failed
    if (node.attempts >= (node.maxAttempts || 2)) {
      node.state = 'failed';
      node.leaseId = null;
      leases.release(body.leaseId);
      registry.adjustInflight(sig.agent, -1);
      scheduler.cascadeFailure(mission, node.id);
      activateReady(mission);
      audit.append({ actor: `agent:${sig.agent}`, action: 'fail_final', sigOk: true, missionId: params.id, nodeId: body.nodeId, meter, detail: { verification: v.detail, attempts: node.attempts } });
      events.broadcast('node_failed', { missionId: params.id, nodeId: body.nodeId, agent: sig.agent, detail: v.detail });
      if (mission.status === 'completed' || mission.status === 'partial_failure' || mission.status === 'failed') {
        events.broadcast('mission_completed', { missionId: params.id, status: mission.status });
      }
      return app.json(res, 422, { ok: false, reason: 'verification_failed_final', verification: v });
    }

    // Return to ready for another attempt
    node.state = 'ready';
    node.leaseId = null;
    leases.release(body.leaseId);
    registry.adjustInflight(sig.agent, -1);
    missionStore.save(mission);
    audit.append({ actor: `agent:${sig.agent}`, action: 'fail_retry', sigOk: true, missionId: params.id, nodeId: body.nodeId, meter, detail: { verification: v.detail, attempts: node.attempts } });
    events.broadcast('node_retry', { missionId: params.id, nodeId: body.nodeId, agent: sig.agent, detail: v.detail });
    app.json(res, 200, { ok: false, verification: v, willRetry: true });
  });
}

module.exports = { register };
