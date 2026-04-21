// Federation handshake: outbound = we call a peer's /v1/federation/handshake
// inbound  = a peer calls ours. Both carry a capability token signed by the
// caller's trust root; receiver verifies signature chains to the pre-shared
// trust-root pubkey (added on `POST /v1/peers`).

const http = require('http');
const https = require('https');
const { URL } = require('url');
const registry = require('../registry/store');
const tokens = require('../credentials/tokens');
const trust = require('../credentials/trustAnchors');

function httpJson(method, urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method,
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// The public capability index is the list of agents we have marked public.
function ourCapabilities() {
  return registry.list()
    .filter(r => r.manifest && r.manifest.public === true)
    .map(r => ({
      agent: r.agent,
      capabilities: r.manifest.capabilities || [],
      models: r.manifest.models || [],
      pubkey: r.pubkey
    }));
}

// Outbound: initiate a handshake with a peer.
// Mints a short-lived capability token signed by OUR root, under sub="peer"
// (identity we present as the initiator). Peer verifies against the trust
// root they pinned when they added us.
async function outboundHandshake({ peerUrl, peerTrustRoot }) {
  const root = trust.ensureRoot();
  const token = tokens.issue({ sub: 'peer', pubkey: root.publicKey, scope: 'peer-handshake', ttlMs: 5 * 60 * 1000 });

  const body = {
    peerTrustRoot: root.publicKey,
    capabilities: ourCapabilities(),
    capabilityToken: token
  };

  const res = await httpJson('POST', peerUrl.replace(/\/$/, '') + '/v1/federation/handshake', body);
  if (res.status !== 200) throw new Error(`peer_handshake_failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (!res.body || !res.body.ourTrustRoot || !Array.isArray(res.body.capabilities)) {
    throw new Error('peer_handshake_malformed_response');
  }
  if (res.body.ourTrustRoot !== peerTrustRoot) {
    throw new Error(`peer_trust_root_mismatch: expected ${peerTrustRoot.slice(0,12)}..., got ${res.body.ourTrustRoot.slice(0,12)}...`);
  }
  return res.body; // { capabilities, ourTrustRoot, updatedAt }
}

// Inbound: called by our /v1/federation/handshake route with a verified token.
function inboundHandshake({ peerTrustRoot }) {
  const root = trust.ensureRoot();
  return {
    capabilities: ourCapabilities(),
    ourTrustRoot: root.publicKey,
    updatedAt: new Date().toISOString()
  };
}

module.exports = { outboundHandshake, inboundHandshake, ourCapabilities, httpJson };
