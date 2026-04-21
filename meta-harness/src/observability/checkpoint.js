// Periodic counter checkpoint so restart preserves totals without an O(n)
// audit replay. Only counters persist; gauges are always live-derived.

const fs = require('fs');
const path = require('path');
const metrics = require('./metrics');

const FILE = path.resolve(__dirname, '..', '..', 'data', 'metrics', 'checkpoint.json');
const INTERVAL_MS = parseInt(process.env.MH_METRICS_CHECKPOINT_MS || '60000', 10);

fs.mkdirSync(path.dirname(FILE), { recursive: true });

function write() {
  const snap = metrics.snapshot();
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), counters: snap.counters }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) { /* checkpoint failures must not crash the service */ }
}

function loadOnBoot() {
  if (!fs.existsSync(FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    metrics.restoreCounters(data.counters || {});
    console.log(`[metrics] restored counters from checkpoint (${Object.keys(data.counters || {}).length} series, ts=${data.ts})`);
  } catch (e) { console.warn('[metrics] checkpoint load failed:', e.message); }
}

let timer = null;
function start() {
  if (timer) return;
  loadOnBoot();
  timer = setInterval(write, INTERVAL_MS);
  timer.unref();
  // Also checkpoint on SIGINT so a clean shutdown is never lossy.
  process.on('SIGINT', () => { try { write(); } catch {} });
}

module.exports = { start, write, loadOnBoot, FILE };
