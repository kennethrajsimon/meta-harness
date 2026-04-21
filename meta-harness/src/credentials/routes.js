// Admin routes for the credentials system.
//   POST /v1/admin/issue-token      mint a capability token
//   POST /v1/admin/revoke-token     add a token hash to the revoked list
//   GET  /v1/admin/trust-roots      list trusted roots
//   POST /v1/admin/trust-roots      add an external trust root (peers)
//   DELETE /v1/admin/trust-roots/:kid   remove a trust root
//   GET  /v1/trust/root             PUBLIC — anyone can fetch our root pubkey
//                                   so peers know what to trust.

const tokens = require('./tokens');
const revocation = require('./revocation');
const trust = require('./trustAnchors');
const audit = require('../audit/log');
const events = require('../ws/events');

function register(app) {
  // Public: operator/peer fetches our root pubkey + kid to establish trust.
  app.route('GET', '/v1/trust/root', (req, res) => {
    const r = trust.ensureRoot();
    app.json(res, 200, { pubkey: r.publicKey, kid: r.kid });
  });

  app.route('POST', '/v1/admin/issue-token', async (req, res, params, body) => {
    if (!body || !body.sub || !body.pubkey) return app.json(res, 400, { error: 'missing_fields' });
    const ttlHours = Number(body.ttlHours);
    const ttlMs = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours * 3600 * 1000 : undefined;
    const token = tokens.issue({ sub: body.sub, pubkey: body.pubkey, scope: body.scope, ttlMs });
    audit.append({ actor: 'operator', action: 'token_issued', detail: { sub: token.sub, kid: token.iss.kid, exp: token.exp } });
    app.json(res, 200, { token });
  }, { adminToken: true });

  app.route('POST', '/v1/admin/revoke-token', async (req, res, params, body) => {
    if (!body) return app.json(res, 400, { error: 'missing_body' });
    let hash = body.tokenHash;
    if (!hash && body.token) hash = revocation.tokenHash(body.token);
    if (!hash) return app.json(res, 400, { error: 'need_tokenHash_or_token' });
    revocation.revoke(hash);
    audit.append({ actor: 'operator', action: 'token_revoked', detail: { hash } });
    app.json(res, 200, { ok: true, hash });
  }, { adminToken: true });

  app.route('GET', '/v1/admin/trust-roots', (req, res) => {
    app.json(res, 200, { roots: trust.listTrustedRoots() });
  }, { adminToken: true });

  app.route('POST', '/v1/admin/trust-roots', async (req, res, params, body) => {
    if (!body || !body.pubkey) return app.json(res, 400, { error: 'missing_pubkey' });
    const added = trust.addTrustedRoot(body.pubkey, body.source || 'admin');
    audit.append({ actor: 'operator', action: 'trust_root_added', detail: { kid: added.kid, source: added.source } });
    events.broadcast('trust_root_added', { kid: added.kid });
    app.json(res, 200, { root: added });
  }, { adminToken: true });

  app.route('DELETE', '/v1/admin/trust-roots/:kid', async (req, res, params) => {
    const removed = trust.removeTrustedRoot(params.kid);
    if (!removed) return app.json(res, 404, { error: 'not_found_or_self' });
    audit.append({ actor: 'operator', action: 'trust_root_removed', detail: { kid: params.kid } });
    events.broadcast('trust_root_removed', { kid: params.kid });
    app.json(res, 200, { ok: true });
  }, { adminToken: true });
}

module.exports = { register };
