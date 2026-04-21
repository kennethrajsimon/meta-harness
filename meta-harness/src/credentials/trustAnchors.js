// Trust-anchor management. The local harness owns one Ed25519 "trust root"
// keypair; it auto-generates on first boot and persists to data/trust/.
// Peers' trust roots can be added to trusted-roots.json so their issued
// capability tokens are accepted here. This mirrors a federated PKI at the
// minimum viable level — no CA chains, just a set of trusted issuers.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const identity = require('../registry/identity');

const TRUST_DIR = path.resolve(__dirname, '..', '..', 'data', 'trust');
const ROOT_SECRET = path.join(TRUST_DIR, 'root.secret.key');
const ROOT_PUB = path.join(TRUST_DIR, 'root.pub');
const TRUSTED_ROOTS = path.join(TRUST_DIR, 'trusted-roots.json');

fs.mkdirSync(TRUST_DIR, { recursive: true });

function kidOf(pubkeyB64) {
  return crypto.createHash('sha256').update(pubkeyB64, 'utf8').digest('hex').slice(0, 16);
}

let cachedRoot = null;

function ensureRoot() {
  if (cachedRoot) return cachedRoot;
  if (fs.existsSync(ROOT_SECRET) && fs.existsSync(ROOT_PUB)) {
    cachedRoot = {
      publicKey: fs.readFileSync(ROOT_PUB, 'utf8').trim(),
      secretKey: fs.readFileSync(ROOT_SECRET, 'utf8').trim()
    };
    cachedRoot.kid = kidOf(cachedRoot.publicKey);
  } else {
    const kp = identity.generateKeypair();
    fs.writeFileSync(ROOT_SECRET, kp.secretKey);
    try { fs.chmodSync(ROOT_SECRET, 0o600); } catch { /* Windows best-effort */ }
    fs.writeFileSync(ROOT_PUB, kp.publicKey);
    cachedRoot = { ...kp, kid: kidOf(kp.publicKey) };
  }
  // Always re-assert self-trust in case trusted-roots.json was wiped or
  // never written (e.g. first run after upgrading from Phase 1).
  const existing = loadTrustedRoots();
  if (!existing[cachedRoot.kid]) addTrustedRoot(cachedRoot.publicKey, 'self');
  return cachedRoot;
}

function loadTrustedRoots() {
  if (!fs.existsSync(TRUSTED_ROOTS)) return {};
  try { return JSON.parse(fs.readFileSync(TRUSTED_ROOTS, 'utf8')); } catch { return {}; }
}

function saveTrustedRoots(map) {
  const tmp = TRUSTED_ROOTS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, TRUSTED_ROOTS);
}

function addTrustedRoot(pubkey, source = 'admin') {
  const map = loadTrustedRoots();
  const kid = kidOf(pubkey);
  const existing = map[kid];
  // Preserve a 'self' source — never let a peer overwrite us into
  // deletable state. If the kid is already self, keep source=self.
  const effectiveSource = existing && existing.source === 'self' ? 'self' : source;
  map[kid] = {
    pubkey,
    kid,
    source: effectiveSource,
    addedAt: existing ? existing.addedAt : new Date().toISOString()
  };
  saveTrustedRoots(map);
  return map[kid];
}

function removeTrustedRoot(kid) {
  const map = loadTrustedRoots();
  if (!map[kid]) return false;
  if (map[kid].source === 'self') return false; // cannot remove self-trust
  delete map[kid];
  saveTrustedRoots(map);
  return true;
}

function lookupTrustedRoot(kid) {
  const map = loadTrustedRoots();
  return map[kid] || null;
}

function listTrustedRoots() {
  const map = loadTrustedRoots();
  return Object.values(map);
}

module.exports = {
  ensureRoot,
  kidOf,
  addTrustedRoot,
  removeTrustedRoot,
  lookupTrustedRoot,
  listTrustedRoots,
  TRUST_DIR, ROOT_PUB
};
