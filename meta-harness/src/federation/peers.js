// Federation peers — other Meta Harness instances we've chosen to talk to.
// `peerId` is derived from trustRoot hash, so operators can't forge it and
// a fork/rekey of a peer is detectable as a different peerId.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FED_DIR = path.resolve(__dirname, '..', '..', 'data', 'federation');
const PEERS_FILE = path.join(FED_DIR, 'peers.json');

fs.mkdirSync(FED_DIR, { recursive: true });

function peerIdFor(trustRoot) {
  return crypto.createHash('sha256').update(trustRoot, 'utf8').digest('hex').slice(0, 16);
}

function load() {
  if (!fs.existsSync(PEERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8')); } catch { return []; }
}

function save(list) {
  const tmp = PEERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, PEERS_FILE);
}

function upsert(peer) {
  const list = load();
  const idx = list.findIndex(p => p.id === peer.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...peer };
  else list.push(peer);
  save(list);
}

function remove(id) {
  const list = load();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  save(list);
  // also delete cached capabilities
  const cache = path.join(FED_DIR, `caps-${id}.json`);
  try { if (fs.existsSync(cache)) fs.unlinkSync(cache); } catch {}
  return true;
}

function list() { return load(); }
function find(id) { return load().find(p => p.id === id) || null; }

function saveCapabilities(peerId, capabilities) {
  const f = path.join(FED_DIR, `caps-${peerId}.json`);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), capabilities }, null, 2));
  fs.renameSync(tmp, f);
}

function loadCapabilities(peerId) {
  const f = path.join(FED_DIR, `caps-${peerId}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function allRemoteCapabilities() {
  const out = [];
  for (const p of load()) {
    const cache = loadCapabilities(p.id);
    if (!cache || !Array.isArray(cache.capabilities)) continue;
    for (const c of cache.capabilities) out.push({ ...c, peerId: p.id });
  }
  return out;
}

module.exports = { peerIdFor, upsert, remove, list, find, saveCapabilities, loadCapabilities, allRemoteCapabilities, FED_DIR };
