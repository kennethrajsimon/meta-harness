// Phase 2.1 smoke test: capability tokens end-to-end.
// 1. Issue token for an isolated test-agent.
// 2. Register with token only (no admin) → 200 authPath=credential.
// 3. Issue second token with a DIFFERENT pubkey for same agent → register
//    succeeds, audit contains pubkey_overridden_by_credential.
// 4. Revoke latest token → re-register → 401 credential_invalid revoked.
// 5. Legacy path (admin + TOFU) still works when MH_REQUIRE_CREDENTIAL unset.

const http = require('http');
const { randomUUID } = require('crypto');
const identity = require('../src/registry/identity');

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN || 'test-token-abc';
const PORT = parseInt(process.env.META_HARNESS_PORT || '20000', 10);
const AGENT = 'credtest_' + process.pid;

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers }
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } else console.log('  ✓', msg); }

function buildManifest(agent, pubkey) {
  const m = {
    agent, version: '1.0.0', pubkey,
    capabilities: ['credtest'], models: ['sonnet'],
    rateLimit: { rpm: 30 },
    nonce: randomUUID(), issuedAt: new Date().toISOString()
  };
  return m;
}

(async () => {
  console.log(`[setup] isolated test agent: ${AGENT}`);

  console.log('\n[1] issue token for test agent');
  const kp1 = identity.generateKeypair();
  const mint1 = await request('POST', '/v1/admin/issue-token', { sub: AGENT, pubkey: kp1.publicKey, ttlHours: 1 }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(mint1.status === 200 && mint1.body.token && mint1.body.token.signature, 'token minted');
  const token1 = mint1.body.token;

  console.log('\n[2] register with token only (no admin token)');
  const manifest1 = buildManifest(AGENT, kp1.publicKey);
  manifest1.signature = identity.sign(manifest1, kp1.secretKey);
  const r2 = await request('POST', '/v1/register', { ...manifest1, capabilityToken: token1 });
  assert(r2.status === 200, `register → 200 (got ${r2.status} ${JSON.stringify(r2.body)})`);
  assert(r2.body.authPath === 'credential', `authPath=credential (got ${r2.body.authPath})`);

  console.log('\n[3] issue SECOND token with a different pubkey → override');
  const kp2 = identity.generateKeypair();
  const mint2 = await request('POST', '/v1/admin/issue-token', { sub: AGENT, pubkey: kp2.publicKey, ttlHours: 1 }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(mint2.status === 200, 'second token minted');
  const token2 = mint2.body.token;
  const manifest2 = buildManifest(AGENT, kp2.publicKey);
  manifest2.signature = identity.sign(manifest2, kp2.secretKey);
  const r3 = await request('POST', '/v1/register', { ...manifest2, capabilityToken: token2 });
  assert(r3.status === 200, `override-register → 200 (got ${r3.status} ${JSON.stringify(r3.body)})`);

  const audit = await request('GET', '/v1/audit?limit=500');
  const overrideEntry = audit.body.entries.find(e => e.action === 'pubkey_overridden_by_credential' && e.actor === `agent:${AGENT}`);
  assert(overrideEntry, 'audit entry pubkey_overridden_by_credential');

  console.log('\n[4] revoke the token hash → next register with it fails');
  const crypto = require('crypto');
  const canonical = identity.canonicalize(token2);
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  const rev = await request('POST', '/v1/admin/revoke-token', { tokenHash: hash }, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(rev.status === 200, 'revoke → 200');

  const manifest3 = buildManifest(AGENT, kp2.publicKey);
  manifest3.signature = identity.sign(manifest3, kp2.secretKey);
  const r4 = await request('POST', '/v1/register', { ...manifest3, capabilityToken: token2 });
  assert(r4.status === 401 && r4.body.reason === 'revoked', `revoked token → 401 revoked (got ${r4.status} ${JSON.stringify(r4.body)})`);

  console.log('\n[5] legacy TOFU path still works (no token, admin token present)');
  const kpLegacy = identity.generateKeypair();
  const legacyAgent = AGENT + '_legacy';
  const manifestL = buildManifest(legacyAgent, kpLegacy.publicKey);
  manifestL.signature = identity.sign(manifestL, kpLegacy.secretKey);
  const r5 = await request('POST', '/v1/register', manifestL, { 'X-Admin-Token': ADMIN_TOKEN });
  assert(r5.status === 200 && r5.body.authPath === 'admin_tofu', `legacy path → 200 authPath=admin_tofu (got ${r5.status} ${JSON.stringify(r5.body)})`);

  console.log('\n[6] legacy path without admin token → 401');
  const nonce2 = { ...manifestL, nonce: randomUUID(), issuedAt: new Date().toISOString() };
  nonce2.signature = identity.sign(nonce2, kpLegacy.secretKey);
  const r6 = await request('POST', '/v1/register', nonce2);
  assert(r6.status === 401, `no-auth register → 401 (got ${r6.status})`);

  console.log('\n[7] GET /v1/trust/root returns our root pubkey + kid');
  const rootInfo = await request('GET', '/v1/trust/root');
  assert(rootInfo.status === 200 && rootInfo.body.pubkey && rootInfo.body.kid, 'root pubkey + kid returned');

  console.log('\nALL PHASE 2.1 SMOKE TESTS PASSED');

  // cleanup
  await request('POST', '/v1/admin/reset-agent', { agent: AGENT }, { 'X-Admin-Token': ADMIN_TOKEN });
  await request('POST', '/v1/admin/reset-agent', { agent: legacyAgent }, { 'X-Admin-Token': ADMIN_TOKEN });
})().catch(e => { console.error(e); process.exit(1); });
