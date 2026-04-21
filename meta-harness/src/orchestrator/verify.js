// Verification runner. Each DAG node carries a verification spec; this
// module runs it and returns {ok, detail}. The caller (complete handler)
// uses the result to transition the node to done or failed.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

function fileExists(spec) {
  const target = path.resolve(PROJECT_ROOT, spec || '');
  const ok = fs.existsSync(target);
  return { ok, detail: ok ? `exists:${target}` : `missing:${target}` };
}

function commandExitZero(spec, timeoutMs = 60000) {
  return new Promise(resolve => {
    if (!spec || typeof spec !== 'string') return resolve({ ok: false, detail: 'empty_spec' });
    const child = spawn(spec, { shell: true, cwd: PROJECT_ROOT });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, detail: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('close', code => {
      clearTimeout(t);
      resolve({ ok: code === 0, detail: `exit=${code}${err ? ' stderr=' + err.slice(0, 200) : ''}` });
    });
    child.on('error', e => {
      clearTimeout(t);
      resolve({ ok: false, detail: `spawn_error:${e.message}` });
    });
  });
}

// reviewer_tag: pass spec is "<missionId>:<reviewerNodeId>" — we check the
// mission's DAG to confirm the reviewer node is done. The caller injects a
// read function so we don't circular-import missionStore.
function reviewerTag(spec, { missionLoad } = {}) {
  if (!spec || typeof spec !== 'string') return { ok: false, detail: 'empty_spec' };
  const [missionId, nodeId] = spec.split(':');
  if (!missionId || !nodeId) return { ok: false, detail: 'bad_spec_format' };
  const mission = missionLoad && missionLoad(missionId);
  if (!mission) return { ok: false, detail: 'mission_not_found' };
  const node = (mission.dag.nodes || []).find(n => n.id === nodeId);
  if (!node) return { ok: false, detail: 'reviewer_node_not_found' };
  return { ok: node.state === 'done', detail: `reviewer_node_state=${node.state}` };
}

async function run(verification, ctx = {}) {
  if (!verification || !verification.type) return { ok: true, detail: 'no_verification' };
  switch (verification.type) {
    case 'file_exists': return fileExists(verification.spec);
    case 'command_exit_zero': return await commandExitZero(verification.spec);
    case 'reviewer_tag': return reviewerTag(verification.spec, ctx);
    default: return { ok: false, detail: `unknown_type:${verification.type}` };
  }
}

module.exports = { run, PROJECT_ROOT };
