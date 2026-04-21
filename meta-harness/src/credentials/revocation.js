// Revocation list: sha256 hashes of revoked capability tokens. Small list,
// stored in memory + JSON. Good enough for MVP; a large production deployment
// would use a bloom filter + periodic full list.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.resolve(__dirname, '..', '..', 'data', 'trust', 'revoked.json');

function tokenHash(token) {
  // Stable hash regardless of field order
  const canonical = require('../registry/identity').canonicalize(token);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

let cache = null;

function load() {
  if (cache) return cache;
  try { cache = new Set(fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : []); }
  catch { cache = new Set(); }
  return cache;
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Array.from(load()), null, 2));
  fs.renameSync(tmp, FILE);
}

function revoke(hash) { load().add(hash); save(); }
function isRevoked(hash) { return load().has(hash); }
function list() { return Array.from(load()); }

module.exports = { tokenHash, revoke, isRevoked, list };
