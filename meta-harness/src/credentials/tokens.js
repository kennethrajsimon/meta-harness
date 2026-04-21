// Capability tokens: Ed25519-signed JSON documents asserting that a given
// `sub` (agent name) is bound to a given `pubkey`, issued by a `kid`
// (trust root) with `iat`/`exp` lifetime. Reuses identity.canonicalize
// (signature field is explicitly excluded) so the verification path is
// already battle-tested.
//
// Token shape:
//   {
//     "iss":   { "pubkey": "...", "kid": "..." },
//     "sub":   "backend",
//     "pubkey": "<agent pubkey>",
//     "scope": "agent",
//     "iat":   "ISO",
//     "exp":   "ISO",
//     "signature": "b64 Ed25519 over canonicalize(token without signature)"
//   }

const identity = require('../registry/identity');
const trust = require('./trustAnchors');
const revocation = require('./revocation');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function issue({ sub, pubkey, scope = 'agent', ttlMs = DEFAULT_TTL_MS }) {
  if (!sub || !pubkey) throw new Error('issue: sub and pubkey required');
  const root = trust.ensureRoot();
  const now = Date.now();
  const body = {
    iss: { pubkey: root.publicKey, kid: root.kid },
    sub,
    pubkey,
    scope,
    iat: new Date(now).toISOString(),
    exp: new Date(now + ttlMs).toISOString()
  };
  const signature = identity.sign(body, root.secretKey);
  return { ...body, signature };
}

// verify returns { ok: true, token, reason? } or { ok: false, reason }
function verify(token, { now = Date.now() } = {}) {
  if (!token || typeof token !== 'object') return { ok: false, reason: 'invalid_token' };
  const required = ['iss', 'sub', 'pubkey', 'iat', 'exp', 'signature'];
  for (const k of required) if (token[k] == null) return { ok: false, reason: `missing_${k}` };
  if (!token.iss.kid || !token.iss.pubkey) return { ok: false, reason: 'invalid_iss' };

  const trusted = trust.lookupTrustedRoot(token.iss.kid);
  if (!trusted) return { ok: false, reason: 'untrusted_issuer' };
  if (trusted.pubkey !== token.iss.pubkey) return { ok: false, reason: 'issuer_pubkey_mismatch' };

  if (revocation.isRevoked(revocation.tokenHash(token))) return { ok: false, reason: 'revoked' };

  const iat = Date.parse(token.iat);
  const exp = Date.parse(token.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return { ok: false, reason: 'bad_timestamps' };
  if (now < iat - 5 * 60 * 1000) return { ok: false, reason: 'not_yet_valid' };
  if (now > exp) return { ok: false, reason: 'expired' };

  const ok = identity.verifySignature({
    bodyForSignature: token,
    pubkey: token.iss.pubkey,
    signature: token.signature
  });
  if (!ok) return { ok: false, reason: 'bad_signature' };

  return { ok: true, token };
}

module.exports = { issue, verify, DEFAULT_TTL_MS };
