// Agent registry: persisted to meta-harness/data/registry/<agent>.json.
// Tracks pinned pubkey, manifest, registeredAt, lastSeen, inflight lease count.
// This module is the single source of truth for "does this agent exist and
// what is its current identity?". It does NOT store any private key material.

const fs = require('fs');
const path = require('path');

const REGISTRY_DIR = path.resolve(__dirname, '..', '..', 'data', 'registry');
fs.mkdirSync(REGISTRY_DIR, { recursive: true });

function file(agent) { return path.join(REGISTRY_DIR, `${agent}.json`); }

function load(agent) {
  const f = file(agent);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function save(record) {
  const f = file(record.agent);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, f);
}

// First-register: pin pubkey. Subsequent registers with the same pubkey are
// allowed (re-advertisement); with a different pubkey they are rejected
// UNLESS `override: true` is passed — in which case the caller has already
// validated a higher-authority credential (capability token) and the new
// pubkey replaces the pinned one.
function upsert(manifest, { override = false } = {}) {
  const existing = load(manifest.agent);
  const now = new Date().toISOString();
  const pubkeyChanged = !!existing && existing.pubkey !== manifest.pubkey;
  if (pubkeyChanged && !override) {
    const err = new Error('pubkey_mismatch');
    err.code = 'pubkey_mismatch';
    err.existingPubkey = existing.pubkey;
    throw err;
  }
  const record = {
    agent: manifest.agent,
    pubkey: manifest.pubkey,
    manifest,
    registeredAt: existing ? existing.registeredAt : now,
    lastSeen: now,
    inflight: existing ? existing.inflight || 0 : 0
  };
  save(record);
  return { record, overridden: pubkeyChanged && override };
}

function touch(agent) {
  const r = load(agent);
  if (!r) return null;
  r.lastSeen = new Date().toISOString();
  save(r);
  return r;
}

function reset(agent) {
  const f = file(agent);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function list() {
  return fs.readdirSync(REGISTRY_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function adjustInflight(agent, delta) {
  const r = load(agent);
  if (!r) return null;
  r.inflight = Math.max(0, (r.inflight || 0) + delta);
  save(r);
  return r;
}

module.exports = { load, save, upsert, touch, reset, list, adjustInflight, REGISTRY_DIR };
