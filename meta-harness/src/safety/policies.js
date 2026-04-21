// Policy engine. Operator-editable rules loaded from
// meta-harness/data/policies.json on startup. Rules can:
//   - forbid an agent from certain task verbs
//   - require a reviewer node when the brief matches a sensitive pattern
//
// If the file is missing, policies default to empty (permissive).

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', '..', 'data', 'policies.json');

const DEFAULTS = {
  denylist: [
    // { agent: 'security', taskPattern: 'self-approve' }
  ],
  requiredReviewer: [
    // regex tested against the brief (case-insensitive)
    'auth', 'crypto', 'payment', 'password', 'secret'
  ]
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE)) cache = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    else cache = DEFAULTS;
  } catch { cache = DEFAULTS; }
  return cache;
}

function reload() { cache = null; return load(); }

function briefRequiresReviewer(brief) {
  const p = load();
  const lc = (brief || '').toLowerCase();
  return (p.requiredReviewer || []).some(pat => lc.includes(String(pat).toLowerCase()));
}

function isTaskForbidden(agent, task) {
  const p = load();
  const list = p.denylist || [];
  return list.some(rule => {
    if (rule.agent && rule.agent !== agent) return false;
    if (rule.taskPattern) {
      try { return new RegExp(rule.taskPattern, 'i').test(task || ''); } catch { return false; }
    }
    return false;
  });
}

module.exports = { load, reload, briefRequiresReviewer, isTaskForbidden, FILE };
