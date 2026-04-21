#!/usr/bin/env node
// onboard-agent — guided onboarding for a new agent.
//
// Runs a pre-flight checklist, performs registration via the credential
// path, verifies the result, optionally performs an end-to-end smoke
// round-trip (--simulate), and writes a personalised runbook to
// data/agent-keys/<name>.onboarding.md that the user can follow to hook
// their agent process up to the harness.
//
// Each step prints ✓ / ✗ / ○ (skipped) so failure is obvious and the user
// knows what to fix. Safe to re-run.

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { randomUUID } = require('crypto');
const identity = require('../src/registry/identity');

const AGENT_KEYS_DIR = path.resolve(__dirname, '..', 'data', 'agent-keys');
fs.mkdirSync(AGENT_KEYS_DIR, { recursive: true });

// ─── CLI parse ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else positional.push(a);
}

if (flags.help || flags.h || positional.length === 0) {
  console.log(`
onboard-agent — guided onboarding for a new Meta Harness agent

USAGE
  node scripts/onboard-agent.js <agent-name> [options]

OPTIONS
  --caps "c1,c2,..."    Capabilities                (default: the agent name)
  --model <m>           opus | sonnet | haiku       (default: sonnet)
  --rpm <n>             rate limit rpm              (default: 30)
  --ttl <hours>         token TTL                   (default: 24)
  --public              mark public for federation
  --simulate            run a full round-trip as this agent (lease → complete)
                        to prove the protocol works before you wire up your
                        real process. Safe; uses a self-verifying test mission.
  --runtime <type>      daemon | broker | mcp | custom   (default: daemon)
                        shapes the runbook with runtime-specific next steps
  --force               overwrite existing keypair
  --host <host>         Meta Harness host           (default: 127.0.0.1)
  --port <port>         Meta Harness port           (default: 20000)

ENV
  META_HARNESS_ADMIN_TOKEN   required

EXAMPLE
  META_HARNESS_ADMIN_TOKEN=xxx \\
    node scripts/onboard-agent.js summariser --caps "summarize,docs" \\
         --simulate --runtime daemon
`);
  process.exit(positional.length === 0 ? 1 : 0);
}

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN;
const NAME = positional[0];
const HOST = flags.host || '127.0.0.1';
const PORT = parseInt(flags.port || '20000', 10);
const MODEL = flags.model || 'sonnet';
const RPM = parseInt(flags.rpm || '30', 10);
const TTL_HOURS = parseInt(flags.ttl || '24', 10);
const PUBLIC = !!flags.public;
const SIMULATE = !!flags.simulate;
const FORCE = !!flags.force;
const RUNTIME = flags.runtime || 'daemon';
const CAPABILITIES = (flags.caps ? String(flags.caps).split(',') : [NAME])
  .map(s => s.trim()).filter(Boolean);

// ─── Step framework ───────────────────────────────────────────────────────
const steps = [];
let currentStep = 0;

function step(num, title, detail = '') {
  currentStep = num;
  const totalStr = `[${num}/${steps.length || '?'}]`;
  console.log(`\n${totalStr} ${title}${detail ? '  ' + detail : ''}`);
}
function ok(msg) { console.log(`  \u001b[32m✓\u001b[0m ${msg}`); }
function bad(msg) { console.error(`  \u001b[31m✗\u001b[0m ${msg}`); }
function skip(msg) { console.log(`  \u001b[33m○\u001b[0m ${msg}`); }
function hint(msg) { console.log(`    \u001b[2m${msg}\u001b[0m`); }
function fatal(msg) { bad(msg); process.exit(1); }

// ─── HTTP helper ──────────────────────────────────────────────────────────
function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: HOST, port: PORT, path: pathname, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: 45000
    }, res => {
      let c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let parsed; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function signedHeaders(agent, secretKey, body) {
  const nonce = randomUUID();
  const issuedAt = new Date().toISOString();
  const signed = { ...(body || {}), _meta: { agent, nonce, issuedAt } };
  const signature = identity.sign(signed, secretKey);
  return { 'X-Agent-Name': agent, 'X-Nonce': nonce, 'X-Issued-At': issuedAt, 'X-Signature': signature };
}

// ─── Runbook writer ───────────────────────────────────────────────────────
function runtimeNextSteps(name, pubkey, tokenFile, keyFile, runtime) {
  const header = `## Next steps (runtime: ${runtime})\n\n`;
  if (runtime === 'broker') {
    return header + `Your agent is a Claude Code subagent managed by the broker. You don't need to run anything — the broker spawns \`claude --agent .claude/agents/${name}.md\` on lease.\n\nVerify: submit a mission targeting \`${name}\` from the Missions UI at http://${HOST}:${PORT}/ui/missions.html\n`;
  }
  if (runtime === 'mcp') {
    return header + `Your agent is an MCP client. Configure your MCP host (Claude Desktop, Cursor) to point at \`meta-harness/bin/meta-mcp.js\` with env \`META_HARNESS_ADMIN_TOKEN\`. It will see \`fleet_list_agents\`, \`fleet_submit_mission\`, \`fleet_mission_status\` tools.\n`;
  }
  if (runtime === 'custom') {
    return header + `You're implementing a custom agent runtime. See /v1/discovery/agent-guide.md for the full protocol. Minimum loop:\n\n1. Long-poll \`POST /v1/agents/${name}/lease\` with an Ed25519-signed empty body.\n2. On 200, execute the task from \`response.node\`.\n3. Call \`POST /v1/missions/<id>/complete\` with the leaseId + artifacts.\n`;
  }
  // daemon (default)
  return header + `Run a simple Node/Python daemon that long-polls for work.

### Minimum working daemon (Node)

\`\`\`js
const nacl = require('tweetnacl'), u = require('tweetnacl-util');
const { randomUUID } = require('crypto');
const fs = require('fs');

const kp = JSON.parse(fs.readFileSync('${keyFile.replace(/\\/g, '\\\\')}', 'utf8'));
const BASE = 'http://${HOST}:${PORT}';

function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const keys = Object.keys(v).filter(k => k !== 'signature').sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
function sign(body) { return u.encodeBase64(nacl.sign.detached(u.decodeUTF8(canonicalize(body)), u.decodeBase64(kp.secretKey))); }
function signedHeaders(body) {
  const m = { agent: '${name}', nonce: randomUUID(), issuedAt: new Date().toISOString() };
  return { 'X-Agent-Name': m.agent, 'X-Nonce': m.nonce, 'X-Issued-At': m.issuedAt,
           'X-Signature': sign({ ...(body||{}), _meta: m }) };
}
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type':'application/json', ...signedHeaders(body) }, body: body ? JSON.stringify(body) : null });
  return { status: r.status, body: r.status !== 204 ? await r.json().catch(() => null) : null };
}

async function loop() {
  while (true) {
    const r = await call('POST', '/v1/agents/${name}/lease', {});
    if (r.status === 200) {
      const { leaseId, mission, node } = r.body;
      console.log('got lease', leaseId, 'for', mission.id, node.id);
      // ... do the actual work here ...
      await call('POST', \`/v1/missions/\${mission.id}/complete\`, {
        leaseId, nodeId: node.id, artifacts: [{ kind: 'text', ref: 'done' }]
      });
    }
  }
}
loop().catch(console.error);
\`\`\`

Save that next to the keypair and run it with \`node\`. Your agent is live.
`;
}

function writeRunbook({ name, pubkey, tokenFile, keyFile, runtime, capabilities, model, tokenExp }) {
  const runbookFile = path.join(AGENT_KEYS_DIR, `${name}.onboarding.md`);
  const body = `# Agent onboarding runbook — \`${name}\`

Generated: ${new Date().toISOString()}

## Agent identity

- **Name**: \`${name}\`
- **Pubkey**: \`${pubkey}\`
- **Capabilities**: ${capabilities.map(c => `\`${c}\``).join(', ')}
- **Model**: \`${model}\`
- **Public (federated)**: ${PUBLIC}

## Secrets

- **Private key file**: \`${keyFile}\`  (keep chmod 600; never commit)
- **Capability token file**: \`${tokenFile}\`  (valid until ${tokenExp})
- **Rotate**: delete the .key, re-run \`onboard-agent.js ${name} --force\`.

## Verify registration

\`\`\`bash
curl http://${HOST}:${PORT}/v1/agents | grep '"agent":"${name}"'
curl http://${HOST}:${PORT}/v1/discovery/agent-guide.md   # full protocol reference
\`\`\`

${runtimeNextSteps(name, pubkey, tokenFile, keyFile, runtime)}

## Submit a test mission targeting this agent

\`\`\`bash
curl -X POST http://${HOST}:${PORT}/v1/missions \\
  -H "Content-Type: application/json" \\
  -H "X-Admin-Token: $META_HARNESS_ADMIN_TOKEN" \\
  -d '{"title":"ping","brief":"noop","dag":{"nodes":[{"id":"n1","title":"t","requiredCapabilities":[],"assignedAgent":"${name}","deliverable":"d","verification":{"type":"command_exit_zero","spec":"node -e \\"process.exit(0)\\""}}]}}'
\`\`\`

## When something goes wrong

| Symptom | Action |
|---|---|
| 401 on /v1/register | token expired or revoked — run \`register-agent.js ${name} --force\` |
| 409 pubkey_mismatch | your keypair was regenerated — re-register with a new token (happens automatically under \`--force\`) |
| lease call hangs forever | agent has no process running; start your daemon or see the broker runtime |
| lease returns 204 | no work matches this agent's capabilities right now; not an error |
| 503 halted | kill-switch is on; ask operator to POST /v1/resume |

## References

- Discovery JSON: http://${HOST}:${PORT}/v1/.well-known/agent-discovery
- Agent guide: http://${HOST}:${PORT}/v1/discovery/agent-guide
- Missions UI: http://${HOST}:${PORT}/ui/missions.html
- README: meta-harness/README.md
`;

  fs.writeFileSync(runbookFile, body);
  return runbookFile;
}

// ─── Steps ────────────────────────────────────────────────────────────────
(async () => {
  const total = SIMULATE ? 8 : 7;
  steps.length = total;

  // ── 1 Pre-flight ──────────────────────────────────────────────────
  step(1, 'Pre-flight checks');
  if (!ADMIN_TOKEN) fatal('META_HARNESS_ADMIN_TOKEN not set');
  ok('META_HARNESS_ADMIN_TOKEN present');
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(NAME)) fatal(`agent name "${NAME}" invalid (must be lowercase, start with letter, ≤64 chars)`);
  ok(`agent name "${NAME}" is valid`);
  const statusReq = await request('GET', '/v1/status').catch(e => ({ status: 0, error: e.message }));
  if (statusReq.status !== 200) {
    fatal(`cannot reach http://${HOST}:${PORT}/v1/status (${statusReq.error || statusReq.status}) — start the harness first`);
  }
  ok(`harness reachable at http://${HOST}:${PORT}`);
  // check admin token by minting a tiny no-op token — if this fails, admin is wrong
  const probe = await request('POST', '/v1/admin/issue-token', { sub: '__probe', pubkey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, { 'X-Admin-Token': ADMIN_TOKEN });
  if (probe.status === 401) fatal('admin token rejected — does it match the env var the service was started with?');
  ok('admin token accepted');

  // ── 2 Check name availability ─────────────────────────────────────
  step(2, 'Check name availability');
  const existing = await request('GET', `/v1/agents/${encodeURIComponent(NAME)}`);
  if (existing.status === 200) {
    if (FORCE) { ok(`"${NAME}" exists but --force supplied; will override via credential`); }
    else { hint(`"${NAME}" is already registered. Re-register with --force if that's intentional.`); ok('proceeding (credential override applies)'); }
  } else if (existing.status === 404) {
    ok(`"${NAME}" is free`);
  } else {
    hint(`unexpected /v1/agents/${NAME} → ${existing.status}; proceeding anyway`);
  }

  // ── 3 Keypair ─────────────────────────────────────────────────────
  step(3, 'Agent keypair');
  const keyFile = path.join(AGENT_KEYS_DIR, `${NAME}.key`);
  let kp;
  if (fs.existsSync(keyFile) && !FORCE) {
    kp = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    ok(`reused existing keypair at ${keyFile}`);
  } else {
    kp = identity.generateKeypair();
    fs.writeFileSync(keyFile, JSON.stringify(kp, null, 2));
    try { fs.chmodSync(keyFile, 0o600); } catch {}
    ok(`generated new Ed25519 keypair → ${keyFile}`);
  }
  hint(`pubkey: ${kp.publicKey}`);

  // ── 4 Mint capability token ───────────────────────────────────────
  step(4, `Mint capability token (ttl ${TTL_HOURS}h)`);
  const mint = await request('POST', '/v1/admin/issue-token',
    { sub: NAME, pubkey: kp.publicKey, ttlHours: TTL_HOURS },
    { 'X-Admin-Token': ADMIN_TOKEN });
  if (mint.status !== 200) fatal(`issue-token → ${mint.status} ${JSON.stringify(mint.body)}`);
  const token = mint.body.token;
  const tokenFile = path.join(AGENT_KEYS_DIR, `${NAME}.token.json`);
  fs.writeFileSync(tokenFile, JSON.stringify(token, null, 2));
  ok(`minted (kid ${token.iss.kid}, exp ${token.exp})`);
  hint(`saved → ${tokenFile}`);

  // ── 5 Sign + register ─────────────────────────────────────────────
  step(5, 'Sign manifest and register');
  const manifest = {
    agent: NAME, version: '1.0.0', pubkey: kp.publicKey,
    capabilities: CAPABILITIES, models: [MODEL],
    rateLimit: { rpm: RPM },
    nonce: randomUUID(), issuedAt: new Date().toISOString(),
    public: PUBLIC
  };
  manifest.signature = identity.sign(manifest, kp.secretKey);
  const reg = await request('POST', '/v1/register', { ...manifest, capabilityToken: token });
  if (reg.status !== 200) fatal(`/v1/register → ${reg.status} ${JSON.stringify(reg.body)}`);
  ok(`registered via ${reg.body.authPath} path`);

  // ── 6 Verify via /v1/agents ───────────────────────────────────────
  step(6, 'Verify agent visible in /v1/agents');
  const listing = await request('GET', '/v1/agents');
  const me = listing.body && listing.body.agents && listing.body.agents.find(a => a.agent === NAME);
  if (!me) fatal('agent not found in /v1/agents after register — unexpected');
  ok(`${NAME} visible, capabilities=${JSON.stringify(me.capabilities)} models=${JSON.stringify(me.models)}`);

  // ── 7 (optional) Simulated round-trip ─────────────────────────────
  if (SIMULATE) {
    step(7, 'Simulated end-to-end round-trip');
    hint('submits a trivial mission, signs a lease request as this agent, completes it. Proves every protocol hop works.');

    const mission = await request('POST', '/v1/missions', {
      title: `onboarding-smoke-${NAME}`,
      brief: 'onboarding smoke',
      dag: {
        nodes: [{
          id: 'n1', title: `onboard ${NAME}`,
          requiredCapabilities: [], assignedAgent: NAME, deliverable: 'smoke',
          verification: { type: 'command_exit_zero', spec: 'node -e "process.exit(0)"' }
        }]
      }
    }, { 'X-Admin-Token': ADMIN_TOKEN });
    if (mission.status !== 201) fatal(`mission create → ${mission.status} ${JSON.stringify(mission.body)}`);
    ok(`submitted mission ${mission.body.missionId}`);

    const lease = await request('POST', `/v1/agents/${NAME}/lease`, {}, signedHeaders(NAME, kp.secretKey, {}));
    if (lease.status !== 200) fatal(`lease → ${lease.status} ${JSON.stringify(lease.body)}`);
    ok(`leased node ${lease.body.node.id}`);

    const done = await request('POST', `/v1/missions/${mission.body.missionId}/complete`,
      { leaseId: lease.body.leaseId, nodeId: lease.body.node.id, artifacts: [{ kind: 'text', ref: 'onboarding' }] },
      signedHeaders(NAME, kp.secretKey, { leaseId: lease.body.leaseId, nodeId: lease.body.node.id, artifacts: [{ kind: 'text', ref: 'onboarding' }] }));
    if (done.status !== 200) fatal(`complete → ${done.status} ${JSON.stringify(done.body)}`);
    ok(`completed, verification=${done.body.verification && done.body.verification.ok}`);
  } else {
    step(7, 'Simulated round-trip');
    skip('--simulate not set; skipped. Re-run with --simulate to verify the lease/progress/complete path.');
  }

  // ── last Write runbook ────────────────────────────────────────────
  step(SIMULATE ? 8 : 7, 'Write personalised runbook');
  const runbookFile = writeRunbook({
    name: NAME, pubkey: kp.publicKey, tokenFile, keyFile, runtime: RUNTIME,
    capabilities: CAPABILITIES, model: MODEL, tokenExp: token.exp
  });
  ok(`runbook → ${runbookFile}`);

  console.log('');
  console.log(`  ============================================`);
  console.log(`     ONBOARDING COMPLETE — ${NAME}`);
  console.log(`  ============================================`);
  console.log('');
  console.log(`  Runbook:   ${runbookFile}`);
  console.log(`  Keypair:   ${keyFile}`);
  console.log(`  Discovery: http://${HOST}:${PORT}/v1/discovery/agent-guide`);
  console.log('');
  console.log(`  Next: open the runbook, follow the "${RUNTIME}" runtime section.`);
  console.log('');
})().catch(e => {
  bad(e.message);
  console.error(e.stack);
  process.exit(1);
});
