// Phase 1b routes: /v1/register and /v1/agents.
// /v1/register requires admin token (mitigates TOFU spoofing) and a valid
// Ed25519 signature over the canonical manifest.
// /v1/agents is public read-only.

const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const fs = require('fs');
const path = require('path');

const identity = require('./identity');
const store = require('./store');
const audit = require('../audit/log');
const events = require('../ws/events');
const credentialTokens = require('../credentials/tokens');

const REQUIRE_CREDENTIAL = ['1', 'true', 'yes', 'on'].includes(String(process.env.MH_REQUIRE_CREDENTIAL || '').toLowerCase());

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const manifestSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'manifest.schema.json'), 'utf8'));
const validateManifest = ajv.compile(manifestSchema);

function register(app) {
  // POST /v1/register — two authentication paths:
  //   1) capabilityToken in body: credential verified; NO admin token required;
  //      overrides a pinned pubkey if they differ (credential > TOFU).
  //   2) no capabilityToken: legacy admin-token + TOFU path (Phase 1 compat).
  //   If MH_REQUIRE_CREDENTIAL=1, path (2) is refused.
  //
  // The handler is registered WITHOUT {adminToken:true} on the route options
  // and performs its own admin-token check when no credential is supplied.
  app.route('POST', '/v1/register', async (req, res, params, body) => {
    if (!body || typeof body !== 'object') return app.json(res, 400, { error: 'invalid_body' });

    const capabilityToken = body.capabilityToken;
    // Allow both: manifest at top-level (Phase 1 shape) OR manifest nested under body.manifest (new shape)
    const manifest = body.manifest || { ...body };
    delete manifest.capabilityToken;
    delete manifest.manifest;

    if (!validateManifest(manifest)) return app.json(res, 400, { error: 'schema_violation', details: validateManifest.errors });

    if (!identity.isFresh(manifest.issuedAt)) return app.json(res, 400, { error: 'stale_or_future_issuedAt' });
    if (identity.isNonceSeen(manifest.agent, manifest.nonce)) return app.json(res, 409, { error: 'nonce_replay' });

    const sigOk = identity.verifySignature({
      bodyForSignature: manifest,
      pubkey: manifest.pubkey,
      signature: manifest.signature
    });
    if (!sigOk) {
      audit.append({ actor: `agent:${manifest.agent}`, action: 'register_denied', detail: { reason: 'bad_signature' }, sigOk: false });
      return app.json(res, 401, { error: 'bad_signature' });
    }

    // ─── Auth path selection ───
    let authPath;  // 'credential' | 'admin_tofu'
    if (capabilityToken) {
      const v = credentialTokens.verify(capabilityToken);
      if (!v.ok) {
        audit.append({ actor: `agent:${manifest.agent}`, action: 'register_denied', detail: { reason: 'credential_' + v.reason }, sigOk: true });
        return app.json(res, 401, { error: 'credential_invalid', reason: v.reason });
      }
      if (v.token.sub !== manifest.agent) return app.json(res, 401, { error: 'credential_sub_mismatch' });
      if (v.token.pubkey !== manifest.pubkey) return app.json(res, 401, { error: 'credential_pubkey_mismatch' });
      authPath = 'credential';
    } else {
      if (REQUIRE_CREDENTIAL) {
        audit.append({ actor: `agent:${manifest.agent}`, action: 'register_denied', detail: { reason: 'credential_required' }, sigOk: true });
        return app.json(res, 403, { error: 'credential_required', hint: 'MH_REQUIRE_CREDENTIAL=1 is set' });
      }
      // Legacy path: check admin token ourselves (since route isn't adminToken-gated)
      const adminToken = require('../safety/adminToken');
      if (!adminToken.verify(req.headers['x-admin-token'])) {
        audit.append({ actor: 'unknown', action: 'admin_token_denied', detail: { path: '/v1/register' } });
        return app.json(res, 401, { error: 'unauthorized' });
      }
      authPath = 'admin_tofu';
    }

    // ─── Persist (with credential override semantics) ───
    let upsertResult;
    try {
      upsertResult = store.upsert(manifest, { override: authPath === 'credential' });
    } catch (e) {
      if (e.code === 'pubkey_mismatch') {
        audit.append({ actor: `agent:${manifest.agent}`, action: 'register_denied', detail: { reason: 'pubkey_mismatch', authPath }, sigOk: true });
        return app.json(res, 409, { error: 'pubkey_mismatch', hint: 'present a valid capability token to override the pinned pubkey' });
      }
      throw e;
    }
    const { record, overridden } = upsertResult;
    identity.rememberNonce(manifest.agent, manifest.nonce);

    if (overridden) {
      audit.append({ actor: `agent:${manifest.agent}`, action: 'pubkey_overridden_by_credential', sigOk: true, detail: { oldPubkey: '(rotated)', kid: capabilityToken.iss.kid } });
      events.broadcast('agent_pubkey_rotated', { agent: record.agent, kid: capabilityToken.iss.kid });
    }

    audit.append({
      actor: `agent:${manifest.agent}`,
      action: 'register',
      sigOk: true,
      detail: { version: manifest.version, capabilities: manifest.capabilities.slice(0, 10), authPath }
    });
    events.broadcast('agent_registered', { agent: record.agent, capabilities: record.manifest.capabilities, authPath });
    return app.json(res, 200, { ok: true, agent: record.agent, registeredAt: record.registeredAt, authPath });
  });

  // GET /v1/agents — public list of registered agents + manifests + liveness.
  // ?includeFederated=1 also includes cached peer capabilities, tagged source.
  app.route('GET', '/v1/agents', (req, res) => {
    const url = require('url');
    const q = url.parse(req.url, true).query;
    const agents = store.list().map(r => ({
      agent: r.agent,
      pubkey: r.pubkey,
      registeredAt: r.registeredAt,
      lastSeen: r.lastSeen,
      inflight: r.inflight || 0,
      capabilities: r.manifest.capabilities,
      models: r.manifest.models,
      version: r.manifest.version,
      rateLimit: r.manifest.rateLimit || null,
      public: r.manifest.public === true,
      source: 'local'
    }));
    let federated = [];
    if (q.includeFederated === '1' || q.includeFederated === 'true') {
      try {
        const peers = require('../federation/peers');
        federated = peers.allRemoteCapabilities().map(c => ({
          agent: c.agent, capabilities: c.capabilities, models: c.models,
          pubkey: c.pubkey, source: 'peer:' + c.peerId, peerId: c.peerId
        }));
      } catch { /* federation module might be unavailable */ }
    }
    app.json(res, 200, { agents: [...agents, ...federated] });
  });

  // GET /v1/agents/:name — single agent detail.
  app.route('GET', '/v1/agents/:name', (req, res, params) => {
    const r = store.load(params.name);
    if (!r) return app.json(res, 404, { error: 'not_found', agent: params.name });
    app.json(res, 200, r);
  });
}

module.exports = { register };
