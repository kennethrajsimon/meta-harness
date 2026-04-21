// Model rate table. User-editable JSON. Missing models return null cost
// with reason="unknown_model" — never silently zero.

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', '..', 'data', 'metering', 'rates.json');

let cache = null;
let mtime = 0;

function load() {
  try {
    const stat = fs.statSync(FILE);
    if (cache && stat.mtimeMs === mtime) return cache;
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    mtime = stat.mtimeMs;
  } catch { cache = {}; }
  return cache;
}

// Returns { estCostCents, estCostReason }
function estimate({ model, leaseHeldMs }) {
  if (!leaseHeldMs || leaseHeldMs < 0) {
    return { estCostCents: null, estCostReason: 'missing_duration' };
  }
  const table = load();
  const rate = table[model];
  if (!rate || typeof rate.perMinuteCents !== 'number') {
    return { estCostCents: null, estCostReason: 'unknown_model' };
  }
  const cents = (leaseHeldMs / 60000) * rate.perMinuteCents;
  // Round to 4 decimal places (hundredth of a cent) — cost is already a
  // rough proxy; spurious precision is worse than a rounded number.
  return { estCostCents: Math.round(cents * 10000) / 10000, estCostReason: 'time_based' };
}

module.exports = { estimate, load, FILE };
