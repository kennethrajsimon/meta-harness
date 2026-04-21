// Broker main loop.
// 1. Discovers agents by scanning .claude/agents/*.md
// 2. For each agent: generate (or load) Ed25519 keypair, register with
//    Meta Harness, long-poll /v1/agents/<name>/lease in a loop
// 3. On lease arrival, write a command into .claude/agent-commands.json
//    containing the task text + leaseId — existing subagent polls it
// 4. Tails .claude/agent-activity.log. When an agent logs status=active
//    after a lease was issued to it, call /v1/missions/:id/progress.
//    When it logs status=complete, call /v1/missions/:id/complete.
// 5. Concurrency-per-agent = 1 (matches Meta Harness default), so the
//    agent-to-lease correlation is unambiguous.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');

const agentKeys = require('./agentKeys');
const { buildClient } = require('./client');
const commandQueue = require('./commandQueue');
const fleetLog = require('./fleetLog');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const AGENTS_DIR = path.join(PROJECT_ROOT, '.claude', 'agents');
const LAUNCHER = path.join(PROJECT_ROOT, '.fleet', 'launch-agent.sh');
const LAUNCH_LOG_DIR = path.resolve(__dirname, '..', '..', 'data', 'logs', 'agent-launches');

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN;
const HOST = process.env.META_HARNESS_HOST || '127.0.0.1';
const PORT = parseInt(process.env.META_HARNESS_PORT || '20000', 10);
const LONGPOLL_TIMEOUT = 32 * 1000; // slightly more than server's 30s long-poll

// Auto-launch: when true, broker spawns the target agent via
// .fleet/launch-agent.sh after issuing a lease. Default ON; set
// MH_AUTO_LAUNCH=0 to keep the old manual behaviour.
const AUTO_LAUNCH = !['0', 'false', 'no', 'off'].includes(String(process.env.MH_AUTO_LAUNCH || '').toLowerCase());

fs.mkdirSync(LAUNCH_LOG_DIR, { recursive: true });

// Check claude CLI availability once at startup; if missing, auto-launch is
// silently disabled and the operator is told to launch agents manually.
let claudeAvailable = null;
function detectClaude() {
  if (claudeAvailable !== null) return claudeAvailable;
  try {
    // Windows: `where claude`; POSIX: `which claude`. spawnSync is safer.
    const r = process.platform === 'win32'
      ? spawnSync('where', ['claude'], { windowsHide: true })
      : spawnSync('which', ['claude']);
    claudeAvailable = r.status === 0;
  } catch { claudeAvailable = false; }
  return claudeAvailable;
}

if (!ADMIN_TOKEN) {
  console.error('[broker] META_HARNESS_ADMIN_TOKEN env var required');
  process.exit(1);
}

const client = buildClient({ host: HOST, port: PORT, adminToken: ADMIN_TOKEN });

// active[agent] = { leaseId, missionId, nodeId, progressSent, issuedAt }
const active = {};

function discoverAgents() {
  if (!fs.existsSync(AGENTS_DIR)) {
    console.error(`[broker] ${AGENTS_DIR} not found`);
    return [];
  }
  const agents = [];
  for (const f of fs.readdirSync(AGENTS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const id = path.basename(f, '.md').toLowerCase();
    const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
    const modelMatch = content.match(/## Model Designation\s*\n\s*(\w+)/i);
    const model = modelMatch ? modelMatch[1].toLowerCase() : 'sonnet';
    const specMatch = content.match(/## Specialization\s*\n([\s\S]*?)(?=\n##|$)/);
    const kws = new Set();
    if (specMatch) {
      for (const line of specMatch[1].split('\n')) {
        if (!line.trim().startsWith('-')) continue;
        line.replace(/^[\s-]+/, '').toLowerCase().split(/[\s,/()+]+/).forEach(w => {
          if (w.length > 3 && !['and', 'the', 'for', 'with', 'from', 'that', 'this'].includes(w)) kws.add(w);
        });
      }
    }
    agents.push({ id, model, capabilities: Array.from(kws).slice(0, 32) });
  }
  return agents;
}

async function registerAgent(a) {
  const kp = agentKeys.ensure(a.id);
  const manifestBody = {
    agent: a.id,
    version: '1.0.0',
    pubkey: kp.publicKey,
    capabilities: a.capabilities.length ? a.capabilities : [a.id],
    models: [a.model],
    rateLimit: { rpm: 60 },
    nonce: randomUUID(),
    issuedAt: new Date().toISOString()
  };
  const identity = require('../registry/identity');
  const signature = identity.sign(manifestBody, kp.secretKey);
  const res = await client.request('POST', '/v1/register', { ...manifestBody, signature }, { 'X-Admin-Token': ADMIN_TOKEN });
  if (res.status === 200) return { ok: true };
  if (res.status === 409 && res.body && res.body.error === 'pubkey_mismatch') {
    console.error(`[broker] ${a.id}: pubkey mismatch. Run reset-agent to re-pin, or delete data/broker-keys/${a.id}.key to regenerate.`);
    return { ok: false, reason: 'pubkey_mismatch' };
  }
  console.error(`[broker] ${a.id} register failed:`, res.status, res.body);
  return { ok: false, reason: 'other' };
}

async function longPollLoop(agent) {
  const kp = agentKeys.load(agent.id);
  if (!kp) return;

  while (true) {
    try {
      if (active[agent.id]) {
        // Already holding a lease — idle until completion event clears it.
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      const res = await client.signedCall('POST', `/v1/agents/${agent.id}/lease`, agent.id, kp.secretKey, {}, { timeoutMs: LONGPOLL_TIMEOUT });
      if (res.status === 200 && res.body && res.body.leaseId) {
        const { leaseId, mission, node } = res.body;
        active[agent.id] = {
          leaseId, missionId: mission.id, nodeId: node.id,
          issuedAt: Date.now(), progressSent: false, launched: false
        };
        const taskText = `${node.title} — ${node.deliverable || ''}`.slice(0, 500);
        commandQueue.enqueue({
          agent: agent.id,
          text: taskText,
          priority: 'high',
          missionId: mission.id, nodeId: node.id, leaseId
        });
        console.log(`[broker] ${agent.id} leased ${leaseId} for ${mission.id}/${node.id}`);
        if (AUTO_LAUNCH) launchAgent(agent, taskText, mission.id, node.id, leaseId);
      } else if (res.status === 204 || res.status === 202) {
        // no work or at concurrency limit — loop around
      } else if (res.status === 503) {
        // halted — back off a bit
        await new Promise(r => setTimeout(r, 3000));
      } else if (res.status === 404 && res.body && res.body.error === 'unknown_agent') {
        // Registry lost us (operator reset or wipe). Re-register and resume.
        console.warn(`[broker] ${agent.id} unknown_agent — re-registering`);
        await registerAgent(agent);
      } else {
        console.warn(`[broker] ${agent.id} lease poll: ${res.status} ${JSON.stringify(res.body)}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.warn(`[broker] ${agent.id} lease loop error:`, e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

function startFleetLogWatcher() {
  const ee = fleetLog.tail();
  ee.on('entry', async entry => {
    const agentId = entry.agent;
    const act = active[agentId];
    if (!act) return;
    const entryTs = Date.parse(entry.timestamp || 0) || Date.now();
    if (entryTs < act.issuedAt - 1000) return; // pre-lease entry

    if (entry.status === 'active' && !act.progressSent) {
      act.progressSent = true;
      const kp = agentKeys.load(agentId);
      try {
        await client.signedCall('POST', `/v1/missions/${act.missionId}/progress`, agentId, kp.secretKey, {
          leaseId: act.leaseId, nodeId: act.nodeId, pct: 10, note: `agent_active: ${String(entry.task || '').slice(0, 120)}`
        });
      } catch (e) { console.warn('[broker] progress send failed:', e.message); }
    }
    if (entry.status === 'complete') {
      const kp = agentKeys.load(agentId);
      try {
        const res = await client.signedCall('POST', `/v1/missions/${act.missionId}/complete`, agentId, kp.secretKey, {
          leaseId: act.leaseId, nodeId: act.nodeId,
          artifacts: [{ kind: 'text', ref: String(entry.task || '').slice(0, 500) }]
        });
        console.log(`[broker] ${agentId} complete → ${res.status} ${res.body && res.body.verification ? 'verify=' + res.body.verification.ok : ''}`);
      } catch (e) { console.warn('[broker] complete send failed:', e.message); }
      delete active[agentId];
    }
    if (entry.status === 'error') {
      const kp = agentKeys.load(agentId);
      try {
        // report as a failed completion — verification will score it
        await client.signedCall('POST', `/v1/missions/${act.missionId}/complete`, agentId, kp.secretKey, {
          leaseId: act.leaseId, nodeId: act.nodeId,
          artifacts: [{ kind: 'text', ref: 'error: ' + String(entry.task || '').slice(0, 400) }]
        });
      } catch (e) { /* swallow */ }
      delete active[agentId];
    }
  });
  return ee;
}

// Spawn a Claude Code session for `agent` and hand it an initial prompt
// that tells it to process the queued command. Detached + stdio:ignore so
// the broker process doesn't block on the claude session's lifetime.
function launchAgent(agent, taskText, missionId, nodeId, leaseId) {
  if (!detectClaude()) {
    console.warn(`[broker] claude CLI not on PATH — auto-launch disabled. Run: bash .fleet/launch-agent.sh ${agent.id} ${agent.model}`);
    return;
  }
  if (!fs.existsSync(LAUNCHER)) {
    console.warn(`[broker] ${LAUNCHER} missing — cannot auto-launch. Falling back to queue-only.`);
    return;
  }

  const prompt = [
    `You are the ${agent.id} agent. A command is waiting in .claude/agent-commands.json with leaseId=${leaseId}.`,
    `Mission ${missionId} / node ${nodeId}: ${taskText}`,
    `Per your agent definition: log active via .fleet/log-agent-activity.sh, execute the task, then log complete. The command's "acknowledged" field should be set to true when you're done. Exit cleanly.`
  ].join(' ');

  const ts = Date.now();
  const outLog = path.join(LAUNCH_LOG_DIR, `${agent.id}-${ts}.log`);
  const outFd = fs.openSync(outLog, 'a');

  try {
    const child = spawn('bash', [LAUNCHER, agent.id, agent.model, prompt], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      windowsHide: true
    });
    child.unref();
    console.log(`[broker] spawned ${agent.id} (pid ${child.pid || '?'}, log ${outLog})`);
  } catch (e) {
    console.warn(`[broker] failed to spawn ${agent.id}:`, e.message);
    try { fs.closeSync(outFd); } catch {}
  }
}

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   META BROKER — ONLINE                   ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Meta Harness: http://${HOST}:${PORT}`);
  console.log(`  Keys dir:     ${agentKeys.DIR}`);
  console.log(`  Cmd queue:    ${commandQueue.CMD_FILE}`);
  console.log(`  Fleet log:    ${fleetLog.LOG_FILE}`);
  console.log(`  Auto-launch:  ${AUTO_LAUNCH ? 'ON' : 'OFF'}  (claude CLI ${detectClaude() ? 'found' : 'NOT found — manual launch required'})`);
  console.log('');

  const agents = discoverAgents();
  console.log(`[broker] discovered ${agents.length} agents: ${agents.map(a => a.id).join(', ')}`);

  for (const a of agents) {
    const r = await registerAgent(a);
    if (r.ok) console.log(`[broker] registered ${a.id}`);
  }

  startFleetLogWatcher();

  // Spawn one long-poll loop per agent.
  for (const a of agents) longPollLoop(a).catch(e => console.error('[broker] loop died:', a.id, e));

  process.on('SIGINT', () => { console.log('\n[broker] shutting down'); process.exit(0); });
}

module.exports = { discoverAgents, registerAgent, main };
