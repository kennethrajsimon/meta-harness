// Lease registry. A lease is a short-lived claim an agent holds on a DAG
// node while it executes. In-memory map + periodic expiration sweep.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const SWEEP_MS = 10 * 1000;

const leases = new Map(); // leaseId -> { missionId, nodeId, agent, expiresAt }

function newId() { return 'ls_' + crypto.randomBytes(8).toString('hex'); }

function issue({ missionId, nodeId, agent, ttlMs = DEFAULT_TTL_MS }) {
  const id = newId();
  leases.set(id, {
    id,
    missionId,
    nodeId,
    agent,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlMs
  });
  return id;
}

function get(id) { return leases.get(id) || null; }

function renew(id, ttlMs = DEFAULT_TTL_MS) {
  const l = leases.get(id);
  if (!l) return null;
  l.expiresAt = Date.now() + ttlMs;
  return l;
}

function release(id) { return leases.delete(id); }

function active() { return Array.from(leases.values()); }

// Periodic sweep. When a lease expires the caller's sweep callback gets the
// lease so it can return the node to `ready` state.
function startSweeper(onExpire) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, l] of leases) {
      if (l.expiresAt < now) {
        leases.delete(id);
        try { onExpire(l); } catch { /* swallow so sweep keeps running */ }
      }
    }
  }, SWEEP_MS).unref();
}

module.exports = { issue, get, renew, release, active, startSweeper, DEFAULT_TTL_MS };
