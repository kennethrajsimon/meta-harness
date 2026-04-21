// Global HALT flag. Presence of data/killswitch.flag on disk means the
// harness refuses new missions, refuses new leases, and existing leases
// expire normally (they simply won't be renewed). This is persistent across
// restarts so a halt survives a crash.

const fs = require('fs');
const path = require('path');

const FLAG = path.resolve(__dirname, '..', '..', 'data', 'killswitch.flag');

function isHalted() {
  try { return fs.existsSync(FLAG); } catch { return false; }
}

function halt(reason) {
  fs.mkdirSync(path.dirname(FLAG), { recursive: true });
  fs.writeFileSync(FLAG, JSON.stringify({ haltedAt: new Date().toISOString(), reason: reason || '' }));
}

function resume() {
  try { fs.unlinkSync(FLAG); } catch {}
}

function info() {
  if (!isHalted()) return { halted: false };
  try {
    return { halted: true, ...JSON.parse(fs.readFileSync(FLAG, 'utf8')) };
  } catch { return { halted: true }; }
}

module.exports = { isHalted, halt, resume, info, FLAG };
