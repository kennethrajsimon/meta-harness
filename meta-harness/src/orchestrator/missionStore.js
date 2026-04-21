// Mission persistence. One JSON file per mission at
// meta-harness/data/missions/<id>.json. Atomic tmp-rename writes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.resolve(__dirname, '..', '..', 'data', 'missions');
fs.mkdirSync(DIR, { recursive: true });

function newId() {
  return 'mis_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function file(id) { return path.join(DIR, `${id}.json`); }

function load(id) {
  const f = file(id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function save(mission) {
  mission.updatedAt = new Date().toISOString();
  const f = file(mission.id);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mission, null, 2));
  fs.renameSync(tmp, f);
  return mission;
}

function list() {
  return fs.readdirSync(DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

module.exports = { load, save, list, newId, DIR };
