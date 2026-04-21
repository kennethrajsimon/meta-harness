#!/usr/bin/env node
// register-agent — end-to-end agent registration helper.
//
//   node scripts/register-agent.js <agent-name> [options]
//
// Steps (fully automated):
//   1. Generate or load an Ed25519 keypair at meta-harness/data/agent-keys/<name>.key
//   2. Mint a capability token via POST /v1/admin/issue-token
//   3. Build a signed manifest
//   4. POST /v1/register using the credential path (no admin token needed on
//      register itself — the capability token replaces it)
//
// Requires: META_HARNESS_ADMIN_TOKEN in the environment.

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
register-agent — register an external agent with the Meta Harness

USAGE
  node scripts/register-agent.js <agent-name> [options]

OPTIONS
  --caps "c1,c2,..."    Comma-separated capabilities (default: the agent name)
  --model <m>           opus | sonnet | haiku   (default: sonnet)
  --rpm <n>             rate limit requests/min (default: 30)
  --ttl <hours>         capability token TTL    (default: 24)
  --public              mark agent public for federation
  --force               overwrite an existing keypair on disk
  --host <host>         Meta Harness host       (default: 127.0.0.1)
  --port <port>         Meta Harness port       (default: 20000)

ENV
  META_HARNESS_ADMIN_TOKEN   required — admin token for minting the capability token

EXAMPLES
  # Minimum — agent named "summariser", keypair auto-generated
  META_HARNESS_ADMIN_TOKEN=xxx node scripts/register-agent.js summariser

  # Custom capabilities + opus model, public for federation
  META_HARNESS_ADMIN_TOKEN=xxx node scripts/register-agent.js translator \\
      --caps "translate,summarize,multilingual" --model opus --public
`);
  process.exit(positional.length === 0 ? 1 : 0);
}

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.error('[register-agent] META_HARNESS_ADMIN_TOKEN not set');
  process.exit(1);
}

const NAME = positional[0];
if (!/^[a-z][a-z0-9_-]{1,63}$/.test(NAME)) {
  console.error(`[register-agent] agent name must match /^[a-z][a-z0-9_-]{1,63}$/ — got "${NAME}"`);
  process.exit(1);
}

const HOST = flags.host || '127.0.0.1';
const PORT = parseInt(flags.port || '20000', 10);
const MODEL = flags.model || 'sonnet';
const RPM = parseInt(flags.rpm || '30', 10);
const TTL_HOURS = parseInt(flags.ttl || '24', 10);
const PUBLIC = !!flags.public;
const FORCE = !!flags.force;
const CAPABILITIES = (flags.caps ? String(flags.caps).split(',') : [NAME])
  .map(s => s.trim()).filter(Boolean);

// ─── HTTP helper ──────────────────────────────────────────────────────────
function request(method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: HOST, port: PORT, path: pathname, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: 10000
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
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

// ─── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[register-agent] target: ${NAME}@${HOST}:${PORT}`);
  console.log(`[register-agent] capabilities: ${CAPABILITIES.join(', ')}   model: ${MODEL}   public: ${PUBLIC}`);

  // Reachability check
  const status = await request('GET', '/v1/status').catch(e => ({ status: 0, error: e.message }));
  if (status.status !== 200) {
    console.error(`[register-agent] cannot reach http://${HOST}:${PORT}/v1/status (${status.error || status.status})`);
    console.error('  is the Meta Harness running? (scripts/start-all.ps1 or scripts/start-all.sh)');
    process.exit(1);
  }

  // Keypair
  const keyFile = path.join(AGENT_KEYS_DIR, `${NAME}.key`);
  let kp;
  if (fs.existsSync(keyFile) && !FORCE) {
    kp = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    console.log(`[register-agent] loaded existing keypair: ${keyFile}`);
  } else {
    kp = identity.generateKeypair();
    fs.writeFileSync(keyFile, JSON.stringify(kp, null, 2));
    try { fs.chmodSync(keyFile, 0o600); } catch { /* Windows best-effort */ }
    console.log(`[register-agent] generated keypair: ${keyFile}`);
  }

  // Mint capability token
  const mint = await request('POST', '/v1/admin/issue-token',
    { sub: NAME, pubkey: kp.publicKey, ttlHours: TTL_HOURS },
    { 'X-Admin-Token': ADMIN_TOKEN });
  if (mint.status !== 200 || !mint.body.token) {
    console.error(`[register-agent] issue-token failed: ${mint.status} ${JSON.stringify(mint.body)}`);
    if (mint.status === 401) console.error('  admin token rejected — check META_HARNESS_ADMIN_TOKEN matches the running service');
    process.exit(1);
  }
  const token = mint.body.token;
  const tokenFile = path.join(AGENT_KEYS_DIR, `${NAME}.token.json`);
  fs.writeFileSync(tokenFile, JSON.stringify(token, null, 2));
  console.log(`[register-agent] minted token (kid=${token.iss.kid}, exp=${token.exp}) → ${tokenFile}`);

  // Build + sign manifest
  const manifest = {
    agent: NAME,
    version: '1.0.0',
    pubkey: kp.publicKey,
    capabilities: CAPABILITIES,
    models: [MODEL],
    rateLimit: { rpm: RPM },
    nonce: randomUUID(),
    issuedAt: new Date().toISOString(),
    public: PUBLIC
  };
  manifest.signature = identity.sign(manifest, kp.secretKey);

  // Register via credential path (no admin token header — token replaces it)
  const reg = await request('POST', '/v1/register', { ...manifest, capabilityToken: token });
  if (reg.status !== 200) {
    console.error(`[register-agent] /v1/register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
    process.exit(1);
  }

  console.log('');
  console.log(`  ============================================`);
  console.log(`     REGISTRATION COMPLETE`);
  console.log(`  ============================================`);
  console.log('');
  console.log(`  Agent:         ${NAME}`);
  console.log(`  Auth path:     ${reg.body.authPath}`);
  console.log(`  Registered at: ${reg.body.registeredAt}`);
  console.log(`  Keypair:       ${keyFile}  (keep this safe — chmod 600)`);
  console.log(`  Token:         ${tokenFile}  (valid ${TTL_HOURS}h)`);
  console.log('');
  console.log(`  Verify:  curl http://${HOST}:${PORT}/v1/agents | grep ${NAME}`);
  console.log('');
  console.log(`  Submit a mission targeting this agent:`);
  console.log(`    curl -X POST http://${HOST}:${PORT}/v1/missions \\`);
  console.log(`      -H "Content-Type: application/json" \\`);
  console.log(`      -H "X-Admin-Token: $META_HARNESS_ADMIN_TOKEN" \\`);
  console.log(`      -d '{"title":"test","brief":"...","dag":{"nodes":[{"id":"n1","title":"t",`);
  console.log(`           "requiredCapabilities":[],"assignedAgent":"${NAME}","deliverable":"d"}]}}'`);
  console.log('');
})().catch(e => {
  console.error('[register-agent] fatal:', e.message);
  process.exit(1);
});
