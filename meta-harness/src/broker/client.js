// Thin HTTP client that signs every agent-originated request with Ed25519.

const http = require('http');
const { randomUUID } = require('crypto');
const identity = require('../registry/identity');

function buildClient({ host = '127.0.0.1', port = 20000, adminToken = null } = {}) {
  function request(method, path, body, extraHeaders = {}, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined && body !== null ? JSON.stringify(body) : null;
      const req = http.request({
        hostname: host, port, path, method,
        headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...extraHeaders },
        timeout: timeoutMs
      }, res => {
        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
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
    return {
      'X-Agent-Name': agent,
      'X-Nonce': nonce,
      'X-Issued-At': issuedAt,
      'X-Signature': signature
    };
  }

  async function adminCall(method, path, body) {
    if (!adminToken) throw new Error('no admin token configured');
    return request(method, path, body, { 'X-Admin-Token': adminToken });
  }

  async function signedCall(method, path, agent, secretKey, body, opts = {}) {
    return request(method, path, body, signedHeaders(agent, secretKey, body), opts);
  }

  return { request, adminCall, signedCall };
}

module.exports = { buildClient };
