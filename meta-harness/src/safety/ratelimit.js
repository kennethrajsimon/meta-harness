// Token-bucket rate limiter, keyed by (agent, endpoint). Capacity derives
// from the agent's manifest rateLimit.rpm (default 60 rpm). Refill is
// continuous: capacity tokens per 60 seconds.

const registry = require('../registry/store');

const buckets = new Map(); // key -> { tokens, lastRefillMs, capacity, refillPerMs }

function keyOf(agent, endpoint) { return `${agent}::${endpoint}`; }

function capacityFor(agent) {
  const r = registry.load(agent);
  const rpm = r && r.manifest && r.manifest.rateLimit && r.manifest.rateLimit.rpm;
  return rpm && rpm > 0 ? rpm : 60;
}

function take(agent, endpoint, cost = 1) {
  const key = keyOf(agent, endpoint);
  let b = buckets.get(key);
  if (!b) {
    const capacity = capacityFor(agent);
    b = { tokens: capacity, lastRefillMs: Date.now(), capacity, refillPerMs: capacity / 60000 };
    buckets.set(key, b);
  }
  const now = Date.now();
  const elapsed = now - b.lastRefillMs;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
  b.lastRefillMs = now;
  if (b.tokens < cost) return { ok: false, retryAfterMs: Math.ceil((cost - b.tokens) / b.refillPerMs) };
  b.tokens -= cost;
  return { ok: true, remaining: Math.floor(b.tokens) };
}

module.exports = { take };
