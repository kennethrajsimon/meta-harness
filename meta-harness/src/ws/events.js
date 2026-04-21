// /v1/events WebSocket fanout. Per-connection send-rate cap so a buggy
// publisher cannot DoS any single subscriber.

const MAX_MSG_PER_SEC = 100;

const clients = new Set();

function register(ws) {
  ws._meta = { windowStart: Date.now(), sent: 0, dropped: 0 };
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    const m = ws._meta;
    const now = Date.now();
    if (now - m.windowStart >= 1000) { m.windowStart = now; m.sent = 0; }
    if (m.sent >= MAX_MSG_PER_SEC) { m.dropped++; continue; }
    m.sent++;
    try { ws.send(msg); } catch { /* client going away */ }
  }
}

function count() { return clients.size; }

module.exports = { register, broadcast, count };
