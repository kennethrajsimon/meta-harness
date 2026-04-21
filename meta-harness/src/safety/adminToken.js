// Admin token: env var META_HARNESS_ADMIN_TOKEN is hashed on first boot and
// compared via sha256 thereafter. Plaintext is never persisted.
// If both env var and hash file are missing, mutating endpoints refuse to
// serve (503 readonly mode).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HASH_FILE = path.resolve(__dirname, '..', '..', 'data', 'admin-token.hash');

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

let cachedHash = null;
let readonly = false;

function init() {
  const env = process.env.META_HARNESS_ADMIN_TOKEN;
  fs.mkdirSync(path.dirname(HASH_FILE), { recursive: true });
  const existing = fs.existsSync(HASH_FILE) ? fs.readFileSync(HASH_FILE, 'utf8').trim() : null;

  if (env && env.length > 0) {
    const hash = sha256(env);
    if (!existing) {
      fs.writeFileSync(HASH_FILE, hash);
    } else if (existing !== hash) {
      // Env var overrides existing hash — operator rotated the token.
      fs.writeFileSync(HASH_FILE, hash);
    }
    cachedHash = hash;
    readonly = false;
  } else if (existing) {
    cachedHash = existing;
    readonly = false;
  } else {
    cachedHash = null;
    readonly = true;
  }
  return { readonly, hasToken: !!cachedHash };
}

function verify(token) {
  if (readonly || !cachedHash) return false;
  if (typeof token !== 'string' || token.length === 0) return false;
  const provided = sha256(token);
  if (provided.length !== cachedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(cachedHash));
}

function isReadonly() { return readonly; }

module.exports = { init, verify, isReadonly };
