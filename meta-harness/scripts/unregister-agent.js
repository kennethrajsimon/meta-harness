#!/usr/bin/env node
// unregister-agent — un-pin an agent's TOFU/credential binding.
// Preserves the local keypair so you can re-register later with --force.

'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN;
if (!ADMIN_TOKEN) { console.error('META_HARNESS_ADMIN_TOKEN not set'); process.exit(1); }

const [, , name, ...rest] = process.argv;
if (!name) { console.log('usage: node scripts/unregister-agent.js <agent-name> [--port 20000] [--delete-key]'); process.exit(1); }
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--') && rest[i + 1] && !rest[i + 1].startsWith('--')) { flags[rest[i].slice(2)] = rest[++i]; }
  else if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = true;
}
const PORT = parseInt(flags.port || '20000', 10);

function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(headers || {}) }
    }, res => {
      let c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let b; try { b = raw ? JSON.parse(raw) : null; } catch { b = raw; }
        resolve({ status: res.statusCode, body: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const r = await req('POST', '/v1/admin/reset-agent', { agent: name }, { 'X-Admin-Token': ADMIN_TOKEN });
  if (r.status !== 200) { console.error(`reset-agent → ${r.status} ${JSON.stringify(r.body)}`); process.exit(1); }
  console.log(`[unregister-agent] reset ${name} in registry`);

  if (flags['delete-key']) {
    const base = path.resolve(__dirname, '..', 'data', 'agent-keys');
    for (const suffix of ['.key', '.token.json']) {
      const f = path.join(base, name + suffix);
      if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`[unregister-agent] deleted ${f}`); }
    }
  } else {
    console.log(`[unregister-agent] keypair preserved — re-register with: node scripts/register-agent.js ${name} --force`);
  }
})().catch(e => { console.error(e); process.exit(1); });
