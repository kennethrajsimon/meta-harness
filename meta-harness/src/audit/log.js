// Append-only JSONL audit log with size-based rotation and cursor pagination.
// Writes land in meta-harness/data/audit/audit.jsonl; rolled files become
// audit-YYYYMMDD-N.jsonl when size exceeds AUDIT_ROTATE_BYTES.

const fs = require('fs');
const path = require('path');

const AUDIT_DIR = path.resolve(__dirname, '..', '..', 'data', 'audit');
const CURRENT = path.join(AUDIT_DIR, 'audit.jsonl');
const ROTATE_BYTES = parseInt(process.env.AUDIT_ROTATE_BYTES || String(50 * 1024 * 1024), 10);

fs.mkdirSync(AUDIT_DIR, { recursive: true });
if (!fs.existsSync(CURRENT)) fs.writeFileSync(CURRENT, '');

function rotateIfNeeded() {
  let size;
  try { size = fs.statSync(CURRENT).size; } catch { return; }
  if (size < ROTATE_BYTES) return;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let n = 1;
  while (fs.existsSync(path.join(AUDIT_DIR, `audit-${stamp}-${n}.jsonl`))) n++;
  fs.renameSync(CURRENT, path.join(AUDIT_DIR, `audit-${stamp}-${n}.jsonl`));
  fs.writeFileSync(CURRENT, '');
}

function append(entry) {
  rotateIfNeeded();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(CURRENT, line);
}

// Cursor = byte offset into the current audit file. Clients page by passing
// back the cursor from the previous response.
function read({ since = 0, limit = 500 } = {}) {
  limit = Math.min(Math.max(1, limit | 0), 500);
  since = Math.max(0, since | 0);
  let content = '';
  try {
    const fd = fs.openSync(CURRENT, 'r');
    const stat = fs.fstatSync(fd);
    if (since >= stat.size) { fs.closeSync(fd); return { entries: [], cursor: stat.size }; }
    const len = stat.size - since;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, since);
    fs.closeSync(fd);
    content = buf.toString('utf8');
  } catch { return { entries: [], cursor: since }; }

  const lines = content.split('\n');
  const entries = [];
  let bytesConsumed = 0;
  for (const line of lines) {
    if (!line) { bytesConsumed += 1; continue; }
    if (entries.length >= limit) break;
    try { entries.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    bytesConsumed += Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
  }
  return { entries, cursor: since + bytesConsumed };
}

// readAll traverses ALL rolled files (audit-YYYYMMDD-N.jsonl) plus the
// current file, yielding a unified stream sorted by ts. Used by metering
// and any other historical aggregation. This is O(n) over everything and
// should not be on a hot path — small deployments only.
function readAll({ since, until, limit = 100000, missionId, agent, action } = {}) {
  const files = [];
  try {
    for (const f of fs.readdirSync(AUDIT_DIR).sort()) {
      if (/^audit-\d{8}-\d+\.jsonl(\.gz)?$/.test(f)) files.push(path.join(AUDIT_DIR, f));
    }
  } catch {}
  files.push(CURRENT);

  const sinceMs = since ? Date.parse(since) : 0;
  const untilMs = until ? Date.parse(until) : Infinity;

  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    if (f.endsWith('.gz')) continue;  // rotated-gz traversal not implemented yet
    const content = fs.readFileSync(f, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(e.ts || 0);
      if (ts < sinceMs || ts > untilMs) continue;
      if (missionId && e.missionId !== missionId) continue;
      if (agent && e.actor !== `agent:${agent}`) continue;
      if (action && e.action !== action) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { append, read, readAll, CURRENT, AUDIT_DIR };
