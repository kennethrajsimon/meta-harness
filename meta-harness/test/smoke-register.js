// Phase 1b smoke test: generate a keypair, sign a manifest, POST /v1/register,
// then verify GET /v1/agents returns it. Intended to run against a
// meta-harness instance started with META_HARNESS_ADMIN_TOKEN=test-token-abc.

const http = require('http');
const { randomUUID } = require('crypto');
const identity = require('../src/registry/identity');

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN || 'test-token-abc';
const PORT = parseInt(process.env.META_HARNESS_PORT || '20000', 10);

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const kp = identity.generateKeypair();
  const manifestBody = {
    agent: 'smoketest_' + process.pid,
    version: '1.0.0',
    pubkey: kp.publicKey,
    capabilities: ['smoke', 'test'],
    models: ['sonnet'],
    rateLimit: { rpm: 30 },
    nonce: randomUUID(),
    issuedAt: new Date().toISOString()
  };
  const signature = identity.sign(manifestBody, kp.secretKey);
  const manifest = { ...manifestBody, signature };

  console.log('→ POST /v1/register without admin token (expect 401)');
  const unauth = await request('POST', '/v1/register', manifest);
  console.log('  status =', unauth.status, 'body =', unauth.body);
  if (unauth.status !== 401) process.exit(1);

  console.log('→ POST /v1/register with admin token (expect 200)');
  const reg = await request('POST', '/v1/register', manifest, { 'X-Admin-Token': ADMIN_TOKEN });
  console.log('  status =', reg.status, 'body =', reg.body);
  if (reg.status !== 200) process.exit(1);

  console.log('→ POST /v1/register replay (same nonce, expect 409 nonce_replay)');
  const replay = await request('POST', '/v1/register', manifest, { 'X-Admin-Token': ADMIN_TOKEN });
  console.log('  status =', replay.status, 'body =', replay.body);
  if (replay.status !== 409 || replay.body.error !== 'nonce_replay') process.exit(1);

  console.log('→ POST /v1/register with different pubkey, new nonce (expect 409 pubkey_mismatch)');
  const kp2 = identity.generateKeypair();
  const bad = { ...manifestBody, pubkey: kp2.publicKey, nonce: randomUUID(), issuedAt: new Date().toISOString() };
  bad.signature = identity.sign(bad, kp2.secretKey);
  const mismatch = await request('POST', '/v1/register', bad, { 'X-Admin-Token': ADMIN_TOKEN });
  console.log('  status =', mismatch.status, 'body =', mismatch.body);
  if (mismatch.status !== 409 || mismatch.body.error !== 'pubkey_mismatch') process.exit(1);

  console.log('→ GET /v1/agents (expect smoketest present)');
  const list = await request('GET', '/v1/agents');
  const found = list.body.agents && list.body.agents.find(a => a.agent === manifestBody.agent);
  console.log('  found =', !!found, 'capabilities =', found && found.capabilities);
  if (!found) process.exit(1);

  console.log('\nALL PHASE 1b SMOKE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
