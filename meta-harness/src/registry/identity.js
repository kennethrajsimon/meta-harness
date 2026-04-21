// Ed25519 identity: canonical-JSON signing + TOFU pubkey pinning +
// nonce replay guard + issuedAt skew check.
//
// Manifests are signed by the agent's private key. The broker holds the
// private key; the Meta Harness only ever sees the public key.
// First register is Trust-On-First-Use: the pubkey is pinned to the agent
// name. Any later register with a different pubkey is rejected until an
// admin-authorised reset (see src/safety/routes.js → reset-agent).

const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');

const NONCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SKEW_MS = 5 * 60 * 1000;

// Stable stringify: sort keys recursively, exclude the signature field.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).filter(k => k !== 'signature').sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function canonicalBytes(obj) {
  return naclUtil.decodeUTF8(canonicalize(obj));
}

// Per-agent seen-nonce sets with timestamp for TTL eviction.
const seen = new Map(); // agent -> Map<nonce, expiresAt>

function rememberNonce(agent, nonce) {
  const now = Date.now();
  let set = seen.get(agent);
  if (!set) { set = new Map(); seen.set(agent, set); }
  for (const [n, exp] of set) if (exp < now) set.delete(n);
  set.set(nonce, now + NONCE_TTL_MS);
}

function isNonceSeen(agent, nonce) {
  const set = seen.get(agent);
  if (!set) return false;
  const exp = set.get(nonce);
  if (!exp) return false;
  if (exp < Date.now()) { set.delete(nonce); return false; }
  return true;
}

// Verify an Ed25519 signature over the canonical JSON of `bodyForSignature`.
// `pubkey` and `signature` are base64 strings.
function verifySignature({ bodyForSignature, pubkey, signature }) {
  try {
    const msg = canonicalBytes(bodyForSignature);
    const sig = naclUtil.decodeBase64(signature);
    const pk = naclUtil.decodeBase64(pubkey);
    if (pk.length !== nacl.sign.publicKeyLength) return false;
    if (sig.length !== nacl.sign.signatureLength) return false;
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch { return false; }
}

// Verify issuedAt is within MAX_SKEW_MS of now.
function isFresh(issuedAt) {
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t)) return false;
  return Math.abs(Date.now() - t) <= MAX_SKEW_MS;
}

// Generate a keypair (for bootstrap tooling / broker first-run).
function generateKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: naclUtil.encodeBase64(kp.publicKey),
    secretKey: naclUtil.encodeBase64(kp.secretKey)
  };
}

// Sign canonical JSON of body (without a signature field) with a base64 secret key.
function sign(body, secretKeyBase64) {
  const sk = naclUtil.decodeBase64(secretKeyBase64);
  const msg = canonicalBytes(body);
  const sig = nacl.sign.detached(msg, sk);
  return naclUtil.encodeBase64(sig);
}

module.exports = {
  canonicalize,
  verifySignature,
  isFresh,
  rememberNonce,
  isNonceSeen,
  generateKeypair,
  sign,
  NONCE_TTL_MS,
  MAX_SKEW_MS
};
