// Phase 1e routes:
//   POST /v1/halt                          (admin-gated)
//   POST /v1/resume                        (admin-gated)
//   GET  /v1/halt                          (public; returns current state)
//   POST /v1/missions/:id/cancel           (admin-gated)
//   POST /v1/admin/reset-agent             (admin-gated; un-pins a TOFU pubkey)

const killswitch = require('./killswitch');
const missionStore = require('../orchestrator/missionStore');
const registryStore = require('../registry/store');
const leases = require('../orchestrator/leases');
const audit = require('../audit/log');
const events = require('../ws/events');

function register(app) {
  app.route('POST', '/v1/halt', async (req, res, params, body) => {
    killswitch.halt((body && body.reason) || 'admin halt');
    // Release every active lease and return its node to ready.
    for (const l of leases.active()) {
      const m = missionStore.load(l.missionId);
      if (!m) { leases.release(l.id); continue; }
      const n = m.dag.nodes.find(x => x.id === l.nodeId);
      if (n && (n.state === 'leased' || n.state === 'in_progress')) {
        n.state = 'ready';
        n.leaseId = null;
        missionStore.save(m);
        registryStore.adjustInflight(l.agent, -1);
      }
      leases.release(l.id);
    }
    audit.append({ actor: 'operator', action: 'halt', detail: killswitch.info() });
    events.broadcast('halted', killswitch.info());
    app.json(res, 200, { ok: true, ...killswitch.info() });
  }, { adminToken: true });

  app.route('POST', '/v1/resume', async (req, res, params, body) => {
    killswitch.resume();
    audit.append({ actor: 'operator', action: 'resume', detail: {} });
    events.broadcast('resumed', {});
    app.json(res, 200, { ok: true, halted: false });
  }, { adminToken: true });

  app.route('GET', '/v1/halt', (req, res) => { app.json(res, 200, killswitch.info()); });

  app.route('POST', '/v1/missions/:id/cancel', async (req, res, params, body) => {
    const m = missionStore.load(params.id);
    if (!m) return app.json(res, 404, { error: 'not_found' });
    if (m.status === 'completed' || m.status === 'failed' || m.status === 'cancelled') {
      return app.json(res, 409, { error: 'already_terminal', status: m.status });
    }
    for (const n of m.dag.nodes) {
      if (n.state === 'pending' || n.state === 'ready' || n.state === 'leased' || n.state === 'in_progress') {
        if (n.leaseId) {
          leases.release(n.leaseId);
          if (n.assignedAgent) registryStore.adjustInflight(n.assignedAgent, -1);
        }
        n.state = 'skipped';
        n.leaseId = null;
      }
    }
    m.status = 'cancelled';
    missionStore.save(m);
    audit.append({ actor: 'operator', action: 'cancel', missionId: m.id });
    events.broadcast('mission_cancelled', { missionId: m.id });
    app.json(res, 200, { ok: true, missionId: m.id, status: m.status });
  }, { adminToken: true });

  app.route('POST', '/v1/admin/reset-agent', async (req, res, params, body) => {
    if (!body || !body.agent) return app.json(res, 400, { error: 'missing_agent' });
    registryStore.reset(body.agent);
    audit.append({ actor: 'operator', action: 'reset_agent', detail: { agent: body.agent } });
    events.broadcast('agent_reset', { agent: body.agent });
    app.json(res, 200, { ok: true, agent: body.agent });
  }, { adminToken: true });
}

module.exports = { register };
