// Broker-side Ed25519 keypair storage, separate from the public registry.
// Keys live at meta-harness/data/broker-keys/<agent>.key as JSON
// { publicKey, secretKey } — base64, file mode 0o600 where supported.

const fs = require('fs');
const path = require('path');
const identity = require('../registry/identity');

const DIR = path.resolve(__dirname, '..', '..', 'data', 'broker-keys');
fs.mkdirSync(DIR, { recursive: true });

function file(agent) { return path.join(DIR, `${agent}.key`); }

function load(agent) {
  const f = file(agent);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function save(agent, keypair) {
  const f = file(agent);
  fs.writeFileSync(f, JSON.stringify(keypair, null, 2));
  try { fs.chmodSync(f, 0o600); } catch { /* Windows: best effort */ }
}

function ensure(agent) {
  const existing = load(agent);
  if (existing) return existing;
  const kp = identity.generateKeypair();
  save(agent, kp);
  return kp;
}

module.exports = { load, save, ensure, DIR };
