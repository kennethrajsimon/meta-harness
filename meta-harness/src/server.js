// HTTP + WebSocket server for the Meta Harness.
// Phase 1a skeleton: server wiring, admin-token middleware, /v1/schemas/*,
// /v1/audit (paginated), WS /v1/events. Additional routes are registered by
// later phases via registerRoutes().

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { WebSocketServer } = require('ws');

const adminToken = require('./safety/adminToken');
const audit = require('./audit/log');
const events = require('./ws/events');

const PORT = parseInt(process.env.META_HARNESS_PORT || '20000', 10);

const SCHEMAS_DIR = path.join(__dirname, 'schemas');
const UI_DIR = path.join(__dirname, 'ui');

const schemaCache = {};
function loadSchema(name) {
  if (schemaCache[name]) return schemaCache[name];
  const file = path.join(SCHEMAS_DIR, `${name}.schema.json`);
  if (!fs.existsSync(file)) return null;
  schemaCache[name] = fs.readFileSync(file, 'utf8');
  return schemaCache[name];
}

const routes = [];

// Register a route. Pattern can include :param segments.
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler, opts });
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Agent-Name, X-Nonce, X-Issued-At, X-Signature',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Audit-Cursor',
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// Phase 1a baseline routes ------------------------------------------------

// Health
route('GET', '/v1/status', (req, res) => {
  json(res, 200, {
    status: 'online',
    version: '0.1.0',
    readonly: adminToken.isReadonly(),
    port: PORT,
    wsClients: events.count()
  });
});

// Schema retrieval
route('GET', '/v1/schemas/:name', (req, res, params) => {
  const body = loadSchema(params.name);
  if (!body) return json(res, 404, { error: 'not_found', schema: params.name });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
});

// Audit trail (paginated)
route('GET', '/v1/audit', (req, res) => {
  const q = url.parse(req.url, true).query;
  const since = q.since ? parseInt(q.since, 10) : 0;
  const limit = q.limit ? parseInt(q.limit, 10) : 500;
  const { entries, cursor } = audit.read({ since, limit });
  json(res, 200, { entries, cursor }, { 'X-Audit-Cursor': String(cursor) });
});

// Static UI (Phase 1g will populate)
route('GET', '/ui/:file', (req, res, params) => {
  const f = path.join(UI_DIR, params.file);
  if (!fs.existsSync(f) || !f.startsWith(UI_DIR)) return json(res, 404, { error: 'not_found' });
  const ext = path.extname(f);
  const ctype = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'application/javascript' : 'text/plain';
  res.writeHead(200, { 'Content-Type': ctype, 'Access-Control-Allow-Origin': '*' });
  res.end(fs.readFileSync(f));
});

route('GET', '/', (req, res) => {
  json(res, 200, {
    service: 'meta-harness',
    version: '0.1.0',
    docs: '/v1/schemas/manifest',
    ui: '/ui/missions.html'
  });
});

// Dispatcher --------------------------------------------------------------

async function dispatch(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token, X-Agent-Name, X-Nonce, X-Issued-At, X-Signature'
    });
    return res.end();
  }
  const parsed = url.parse(req.url);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = parsed.pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    try {
      let body;
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) body = await readBody(req).catch(() => ({}));
      if (r.opts.adminToken) {
        const token = req.headers['x-admin-token'];
        if (!adminToken.verify(token)) {
          audit.append({ actor: 'unknown', action: 'admin_token_denied', detail: { path: parsed.pathname } });
          return json(res, 401, { error: 'unauthorized' });
        }
      }
      return await r.handler(req, res, params, body);
    } catch (e) {
      console.error('[server] handler error:', e.message);
      return json(res, e.status || 500, { error: 'internal', message: e.message });
    }
  }
  json(res, 404, { error: 'not_found', path: parsed.pathname });
}

function registerRoutes(fn) { fn(route); }

function start() {
  const init = adminToken.init();
  if (init.readonly) {
    console.warn('[meta-harness] No admin token configured. Running in READONLY mode.');
    console.warn('[meta-harness] Set META_HARNESS_ADMIN_TOKEN to enable mutating endpoints.');
  } else {
    console.log('[meta-harness] Admin token armed.');
  }

  const server = http.createServer(dispatch);
  const wss = new WebSocketServer({ server, path: '/v1/events' });
  wss.on('connection', ws => {
    events.register(ws);
    ws.send(JSON.stringify({ type: 'hello', data: { version: '0.1.0' }, ts: new Date().toISOString() }));
  });

  server.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║   META HARNESS — ONLINE                  ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log(`  HTTP:   http://localhost:${PORT}`);
    console.log(`  WS:     ws://localhost:${PORT}/v1/events`);
    console.log(`  Audit:  ${audit.CURRENT}`);
    console.log(`  Mode:   ${init.readonly ? 'READONLY' : 'ADMIN ARMED'}`);
    console.log('');
  });

  process.on('SIGINT', () => {
    console.log('\n[meta-harness] Shutting down...');
    wss.close();
    server.close();
    process.exit(0);
  });

  return { server, wss };
}

module.exports = { start, route, registerRoutes, json, readBody, events, audit, adminToken };
