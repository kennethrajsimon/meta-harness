// Tail .claude/agent-activity.log (append-only JSONL) and emit parsed
// entries to subscribed listeners. New lines only, starting at current EOF.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_FILE = path.resolve(__dirname, '..', '..', '..', '.claude', 'agent-activity.log');

function tail() {
  const ee = new EventEmitter();
  if (!fs.existsSync(LOG_FILE)) {
    try { fs.writeFileSync(LOG_FILE, ''); } catch { /* best effort */ }
  }

  let offset = 0;
  try { offset = fs.statSync(LOG_FILE).size; } catch {}

  function read() {
    let size;
    try { size = fs.statSync(LOG_FILE).size; } catch { return; }
    if (size === offset) return;
    if (size < offset) { offset = 0; } // truncation
    const stream = fs.createReadStream(LOG_FILE, { start: offset, encoding: 'utf8' });
    let buf = '';
    stream.on('data', c => { buf += c; });
    stream.on('end', () => {
      offset = size;
      const lines = buf.split('\n').filter(Boolean);
      for (const line of lines) {
        try { ee.emit('entry', JSON.parse(line)); } catch { /* ignore corrupt */ }
      }
    });
  }

  try { fs.watch(LOG_FILE, () => read()); } catch { /* fall back to polling */ }
  const interval = setInterval(read, 500);
  ee.stop = () => clearInterval(interval);
  return ee;
}

module.exports = { tail, LOG_FILE };
