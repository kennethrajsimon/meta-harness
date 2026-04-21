// agent-bridge.js — WebSocket bridge for Fleet Command Dashboard
// Connects the dashboard to the agent activity log and command queue
// Auto-discovers agents from .claude/agents/*.md files
// Start: node agent-bridge.js
// Port: 27182 (configurable via FLEET_PORT env var)
// Requires: npm install ws

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.FLEET_PORT || '27182', 10);
const CLAUDE_DIR = path.join(__dirname, '..', '.claude');
const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
const LOG_FILE = path.join(CLAUDE_DIR, 'agent-activity.log');
const CMD_FILE = path.join(CLAUDE_DIR, 'agent-commands.json');
const HEARTBEAT_DIR = path.join(CLAUDE_DIR, 'agent-heartbeats');

// Ensure directories/files exist
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
fs.mkdirSync(AGENTS_DIR, { recursive: true });
fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
if (!fs.existsSync(CMD_FILE)) fs.writeFileSync(CMD_FILE, '[]');

let logOffset = 0;

// ─── AGENT DISCOVERY ─────────────────────────────────────────────────────────
// Scan .claude/agents/*.md and extract agent metadata from markdown structure

function discoverAgents() {
  const agents = [];
  let files;
  try {
    files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  } catch (e) {
    console.warn('[BRIDGE] No agents directory found — dashboard will start empty');
    return agents;
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
      const id = path.basename(file, '.md').toLowerCase();

      // Extract name from first heading: "# NAME Agent"
      const nameMatch = content.match(/^#\s+(\w+)/m);
      const name = nameMatch ? nameMatch[1].toUpperCase() : id.toUpperCase();

      // Extract role from "## Role" section (first line after heading)
      const roleMatch = content.match(/## Role\s*\n(.+)/);
      const roleLine = roleMatch ? roleMatch[1].trim() : '';
      // Take first sentence or up to comma for a short role description
      const role = roleLine.split(/[.!]/)[0].replace(/^The \w+ agent (?:is responsible for|builds and maintains|creates and maintains|handles|performs|focuses on) ?/i, '').trim() || roleLine.slice(0, 60);

      // Extract model from "## Model Designation" section
      const modelMatch = content.match(/## Model Designation\s*\n\s*(\w+)/i);
      const model = modelMatch ? modelMatch[1].toLowerCase() : 'sonnet';

      // Extract specialization keywords for smart routing
      const specMatch = content.match(/## Specialization\s*\n([\s\S]*?)(?=\n##|$)/);
      const keywords = [];
      if (specMatch) {
        const lines = specMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
        lines.forEach(l => {
          // Extract meaningful words from each bullet
          const words = l.replace(/^[\s-]+/, '').toLowerCase()
            .split(/[\s,/()+]+/)
            .filter(w => w.length > 3 && !['and', 'the', 'for', 'with', 'from', 'that', 'this'].includes(w));
          keywords.push(...words);
        });
      }

      agents.push({ id, name, model, role, keywords });
    } catch (e) {
      console.warn(`[BRIDGE] Failed to parse ${file}: ${e.message}`);
    }
  }

  console.log(`[BRIDGE] Discovered ${agents.length} agents: ${agents.map(a => a.id).join(', ')}`);
  return agents;
}

// Build the full config object the dashboard needs
function buildConfig(agents) {
  // Auto-generate 3D positions in a 3D spiral formation
  const positions = [];
  const count = agents.length;
  if (count <= 1) {
    positions.push({ x: 0, y: 0, z: 0 });
  } else {
    // 3D spiral: agents wind outward and upward like a helix
    const totalTurns = 2.0;  // number of full rotations
    const maxRadius = 8;
    const heightRange = 6;   // total vertical spread
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);  // 0 → 1
      const angle = t * totalTurns * Math.PI * 2;
      const radius = 1.5 + t * maxRadius;
      const y = (heightRange / 2) - t * heightRange;  // top to bottom
      positions.push({
        x: Math.round(Math.cos(angle) * radius * 10) / 10,
        y: Math.round(y * 10) / 10,
        z: Math.round(Math.sin(angle) * radius * 10) / 10
      });
    }
  }

  // Auto-generate connections based on role proximity
  const connections = [];
  const roleCategories = {
    planning:  ['architect', 'researcher', 'planner', 'strategist'],
    engineering: ['backend', 'frontend', 'database', 'fullstack', 'engineer', 'developer'],
    quality:   ['qa', 'security', 'reviewer', 'tester', 'auditor'],
    infra:     ['devops', 'perf', 'sre', 'ops', 'infra', 'platform'],
    docs:      ['docs', 'writer', 'documentation', 'technical_writer'],
  };

  function getCategory(agentId) {
    for (const [cat, ids] of Object.entries(roleCategories)) {
      if (ids.some(k => agentId.includes(k))) return cat;
    }
    return 'other';
  }

  // Connect agents in same category
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const catA = getCategory(agents[i].id);
      const catB = getCategory(agents[j].id);
      if (catA === catB) {
        connections.push([agents[i].id, agents[j].id]);
      }
    }
  }
  // Cross-category connections: connect first member of each category
  const catLeaders = {};
  agents.forEach(a => {
    const cat = getCategory(a.id);
    if (!catLeaders[cat]) catLeaders[cat] = a.id;
  });
  const leaderIds = Object.values(catLeaders);
  for (let i = 0; i < leaderIds.length; i++) {
    for (let j = i + 1; j < leaderIds.length; j++) {
      connections.push([leaderIds[i], leaderIds[j]]);
    }
  }

  // Auto-generate zones from categories
  const zoneColors = {
    planning: 0xdd88ff,
    engineering: 0x00ffff,
    quality: 0xffaa44,
    infra: 0x44ff88,
    docs: 0x88ddff,
    other: 0xaaaaaa,
  };
  const zoneNames = {
    planning: 'Architecture & Planning',
    engineering: 'Core Engineering',
    quality: 'Quality & Security',
    infra: 'Infrastructure & Delivery',
    docs: 'Documentation',
    other: 'Other',
  };
  const zoneMap = {};
  agents.forEach(a => {
    const cat = getCategory(a.id);
    if (!zoneMap[cat]) zoneMap[cat] = [];
    zoneMap[cat].push(a.id);
  });
  const zones = Object.entries(zoneMap).map(([cat, members]) => ({
    name: zoneNames[cat] || cat,
    members,
    color: zoneColors[cat] || 0xaaaaaa,
  }));

  // Auto-generate colors (HSL cycle)
  const colors = {};
  agents.forEach((a, i) => {
    const hue = (i / agents.length) * 360;
    colors[a.id] = `hsl(${Math.round(hue)}, 75%, 65%)`;
  });

  // Auto-generate template commands based on role keywords
  const templates = {};
  const defaultTemplates = ['Start task:', 'Investigate:', 'Fix issue in:'];
  agents.forEach(a => {
    if (a.keywords && a.keywords.length > 0) {
      // Generate templates from first few specialization keywords
      const kws = [...new Set(a.keywords)].slice(0, 3);
      templates[a.id] = kws.map(k => `${k.charAt(0).toUpperCase() + k.slice(1)}...`);
      if (templates[a.id].length < 3) {
        templates[a.id].push(...defaultTemplates.slice(0, 3 - templates[a.id].length));
      }
    } else {
      templates[a.id] = defaultTemplates;
    }
  });

  // Build roster with positions
  const roster = agents.map((a, i) => ({
    id: a.id,
    name: a.name,
    model: a.model,
    role: a.role,
    keywords: a.keywords || [],
    x: positions[i] ? positions[i].x : 0,
    y: positions[i] ? positions[i].y : 0,
    z: positions[i] ? positions[i].z : 0,
  }));

  return {
    roster,
    connections,
    zones,
    colors,
    templates,
    modelCosts: {
      opus:   { input: 0.015,  output: 0.075 },
      sonnet: { input: 0.003,  output: 0.015 },
      haiku:  { input: 0.0008, output: 0.004 },
    },
    port: PORT,
  };
}

// Discover and build config at startup
let discoveredAgents = discoverAgents();
let fleetConfig = buildConfig(discoveredAgents);

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Serve dashboard HTML at root or /dashboard
  if (req.url === '/' || req.url === '/dashboard') {
    const dashPath = path.join(__dirname, 'agent-dashboard.html');
    try {
      const content = fs.readFileSync(dashPath, 'utf8');
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch (e) {
      res.writeHead(404, headers);
      res.end('agent-dashboard.html not found');
    }
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // Fleet config endpoint — dashboard fetches this on load
  if (req.url === '/config') {
    res.writeHead(200, headers);
    res.end(JSON.stringify(fleetConfig));
    return;
  }

  // Re-scan agents on demand
  if (req.url === '/config/refresh') {
    discoveredAgents = discoverAgents();
    fleetConfig = buildConfig(discoveredAgents);
    res.writeHead(200, headers);
    res.end(JSON.stringify(fleetConfig));
    return;
  }

  if (req.url === '/log' || req.url === '/agent-activity.log') {
    try {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' });
      res.end(content);
    } catch (e) {
      res.writeHead(200, headers);
      res.end('');
    }
    return;
  }

  if (req.url === '/commands' || req.url === '/agent-commands.json') {
    try {
      const content = fs.readFileSync(CMD_FILE, 'utf8');
      res.writeHead(200, headers);
      res.end(content);
    } catch (e) {
      res.writeHead(200, headers);
      res.end('[]');
    }
    return;
  }

  res.writeHead(200, headers);
  res.end(JSON.stringify({ status: 'Fleet Command Bridge Online', port: PORT, agents: discoveredAgents.length }));
});

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log(`[BRIDGE] Client connected (${wss.clients.size} total)`);

  // Send config first so dashboard can initialize
  ws.send(JSON.stringify({ type: 'config', data: fleetConfig }));

  // Send full log on connect
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    ws.send(JSON.stringify({ type: 'full_log', data: lines }));
    logOffset = fs.statSync(LOG_FILE).size;
    console.log(`[BRIDGE] Sent config + full_log (${lines.length} entries)`);
  } catch (e) {
    ws.send(JSON.stringify({ type: 'full_log', data: [] }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(ws, msg);
    } catch (e) {
      console.error('[BRIDGE] Invalid message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[BRIDGE] Client disconnected (${wss.clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error('[BRIDGE] Socket error:', err.message);
  });
});

// ─── Message Handlers ────────────────────────────────────────────────────────

function handleMessage(ws, msg) {
  switch (msg.action) {
    case 'write_command':
      writeCommand(msg.payload, ws);
      break;

    case 'read_log':
      try {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        ws.send(JSON.stringify({ type: 'full_log', data: lines }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'full_log', data: [] }));
      }
      break;

    case 'read_commands':
      try {
        const content = fs.readFileSync(CMD_FILE, 'utf8');
        ws.send(JSON.stringify({ type: 'commands', data: JSON.parse(content) }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'commands', data: [] }));
      }
      break;

    case 'force_status':
      if (msg.payload && msg.payload.agent && msg.payload.status) {
        autoTransition(msg.payload.agent, msg.payload.status, msg.payload.reason || 'Manual override');
        ws.send(JSON.stringify({ type: 'command_ack', command: { id: 'force_' + Date.now(), target: msg.payload.agent } }));
      }
      break;

    case 'get_health':
      ws.send(JSON.stringify({ type: 'health', data: getAgentHealth() }));
      break;

    case 'refresh_config':
      discoveredAgents = discoverAgents();
      fleetConfig = buildConfig(discoveredAgents);
      ws.send(JSON.stringify({ type: 'config', data: fleetConfig }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown action: ' + msg.action }));
  }
}

function writeCommand(command, ws) {
  try {
    let commands = [];
    try {
      commands = JSON.parse(fs.readFileSync(CMD_FILE, 'utf8'));
    } catch (e) {
      commands = [];
    }

    command.id = command.id || 'cmd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    command.acknowledged = false;
    command.timestamp = command.timestamp || new Date().toISOString();
    command.source = command.source || 'fleet-command';
    commands.push(command);

    const tmpFile = CMD_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(commands, null, 2));
    fs.renameSync(tmpFile, CMD_FILE);

    const ack = { type: 'command_ack', command };
    ws.send(JSON.stringify(ack));

    // Broadcast to all clients
    const written = JSON.stringify({ type: 'command_written', command });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(written);
    }

    console.log(`[BRIDGE] Command ${command.id} queued for ${command.target}`);
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to write command: ' + e.message }));
  }
}

// ─── File Watcher ────────────────────────────────────────────────────────────

function checkLogForNewLines() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > logOffset) {
      const stream = fs.createReadStream(LOG_FILE, { start: logOffset, encoding: 'utf8' });
      let buffer = '';
      stream.on('data', chunk => buffer += chunk);
      stream.on('end', () => {
        logOffset = stat.size;
        const lines = buffer.split('\n').filter(Boolean);
        lines.forEach(line => {
          const msg = JSON.stringify({ type: 'log_line', data: line });
          for (const client of wss.clients) {
            if (client.readyState === 1) client.send(msg);
          }
        });
        if (lines.length > 0) {
          console.log(`[BRIDGE] Pushed ${lines.length} new log line(s) to ${wss.clients.size} client(s)`);
        }
      });
    }
  } catch (e) {
    console.error('[BRIDGE] Watch read error:', e.message);
  }
}

let watchDebounce = null;
try {
  fs.watch(LOG_FILE, () => {
    if (watchDebounce) return;
    watchDebounce = setTimeout(() => {
      watchDebounce = null;
      checkLogForNewLines();
    }, 100);
  });
} catch (e) {
  console.error('[BRIDGE] Could not watch log file:', e.message);
}

// Polling fallback — catches changes fs.watch misses (common on Windows)
setInterval(checkLogForNewLines, 500);

// ─── Staleness Detection & Auto-Transition ───────────────────────────────────

const STALE_THRESHOLD_MS = 5 * 60 * 1000;      // 5 min — heartbeat stale
const LOG_STALE_THRESHOLD_MS = 10 * 60 * 1000;  // 10 min — log-only stale
const HEALTH_CHECK_INTERVAL = 30 * 1000;         // check every 30s

function buildCurrentAgentStates() {
  const states = {};
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.agent) states[entry.agent] = entry;
      } catch (e) {}
    }
  } catch (e) {}
  return states;
}

function autoTransition(agent, status, reason) {
  const timestamp = new Date().toISOString();
  const entry = JSON.stringify({
    timestamp, agent, status,
    task: `[AUTO] ${reason}`,
    model: 'system',
    synthetic: true
  });

  fs.appendFileSync(LOG_FILE, entry + '\n');
  logOffset = fs.statSync(LOG_FILE).size;

  const msg = JSON.stringify({ type: 'log_line', data: entry });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }

  try { fs.unlinkSync(path.join(HEARTBEAT_DIR, `${agent}.heartbeat`)); } catch (e) {}

  console.log(`[BRIDGE] Auto-transitioned ${agent} to ${status}: ${reason}`);
}

function getAgentHealth() {
  const states = buildCurrentAgentStates();
  const health = {};
  const now = Date.now();

  for (const [agent, state] of Object.entries(states)) {
    let lastHeartbeat = null;
    try {
      lastHeartbeat = fs.readFileSync(path.join(HEARTBEAT_DIR, `${agent}.heartbeat`), 'utf8').trim();
    } catch (e) {}

    const logAge = now - new Date(state.timestamp).getTime();
    health[agent] = {
      status: state.status,
      lastLogTimestamp: state.timestamp,
      lastHeartbeat,
      logAgeMs: logAge,
      task: state.task,
      synthetic: !!state.synthetic
    };
  }
  return health;
}

function checkStaleness() {
  const states = buildCurrentAgentStates();
  const now = Date.now();

  for (const [agent, state] of Object.entries(states)) {
    if (state.status !== 'active') continue;
    if (state.synthetic) continue;

    const logAge = now - new Date(state.timestamp).getTime();

    const hbFile = path.join(HEARTBEAT_DIR, `${agent}.heartbeat`);
    let heartbeatFresh = false;
    try {
      const hbTime = new Date(fs.readFileSync(hbFile, 'utf8').trim()).getTime();
      heartbeatFresh = (now - hbTime) < STALE_THRESHOLD_MS;
    } catch (e) {}

    if (heartbeatFresh) continue;

    if (logAge > LOG_STALE_THRESHOLD_MS) {
      autoTransition(agent, 'stale',
        `Active for ${Math.round(logAge / 60000)}min with no heartbeat or log update`);
    }
  }
}

setInterval(checkStaleness, HEALTH_CHECK_INTERVAL);
console.log(`[BRIDGE] Staleness monitor active (check every ${HEALTH_CHECK_INTERVAL/1000}s, log threshold ${LOG_STALE_THRESHOLD_MS/60000}min)`);

// ─── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║    FLEET COMMAND BRIDGE — ONLINE     ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  HTTP:      http://localhost:${PORT}`);
  console.log(`  Config:    http://localhost:${PORT}/config`);
  console.log(`  Agents:    ${discoveredAgents.length} discovered`);
  console.log(`  Log file:  ${LOG_FILE}`);
  console.log(`  Commands:  ${CMD_FILE}`);
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n[BRIDGE] Shutting down...');
  wss.close();
  server.close();
  process.exit(0);
});
