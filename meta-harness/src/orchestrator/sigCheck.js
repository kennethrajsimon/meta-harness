// Shared helper: verify Ed25519 signature on an agent-originated request.
// Headers: X-Agent-Name, X-Nonce, X-Issued-At, X-Signature.
// The signature is over canonical JSON of { ...body, _meta: {agent,nonce,issuedAt} }
// — binding headers to body so swapping one doesn't create a replay.

const identity = require('../registry/identity');
const store = require('../registry/store');

function check(req, body) {
  const agent = req.headers['x-agent-name'];
  const nonce = req.headers['x-nonce'];
  const issuedAt = req.headers['x-issued-at'];
  const signature = req.headers['x-signature'];
  if (!agent || !nonce || !issuedAt || !signature) {
    return { ok: false, status: 400, error: 'missing_sig_headers' };
  }
  if (!identity.isFresh(issuedAt)) return { ok: false, status: 400, error: 'stale_or_future_issuedAt' };
  if (identity.isNonceSeen(agent, nonce)) return { ok: false, status: 409, error: 'nonce_replay' };
  const record = store.load(agent);
  if (!record) return { ok: false, status: 404, error: 'unknown_agent' };
  const signed = { ...(body || {}), _meta: { agent, nonce, issuedAt } };
  const ok = identity.verifySignature({ bodyForSignature: signed, pubkey: record.pubkey, signature });
  if (!ok) return { ok: false, status: 401, error: 'bad_signature' };
  identity.rememberNonce(agent, nonce);
  return { ok: true, agent, record };
}

module.exports = { check };
