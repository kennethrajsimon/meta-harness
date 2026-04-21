// Phase 1h smoke test: spawn bin/meta-mcp.js, issue initialize + tools/list
// + tools/call over JSON-RPC stdio, assert fleet_list_agents returns the
// registered agents. Assumes Meta Harness is running on :20000.

const { spawn } = require('child_process');
const path = require('path');

const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN || 'test-token-abc';

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } else console.log('  ✓', msg); }

function framed(msg) { return JSON.stringify(msg) + '\n'; }

function runMcp() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'bin', 'meta-mcp.js')], {
      env: { ...process.env, META_HARNESS_ADMIN_TOKEN: ADMIN_TOKEN }
    });

    let stdoutBuf = '';
    const responses = {};
    const waiters = {};

    child.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) {
            responses[msg.id] = msg;
            if (waiters[msg.id]) { waiters[msg.id](msg); delete waiters[msg.id]; }
          }
        } catch (e) { /* ignore non-JSON (shouldn't happen on stdout) */ }
      }
    });

    child.stderr.on('data', c => process.stderr.write('[mcp stderr] ' + c.toString()));
    child.on('error', reject);

    let nextId = 1;
    function send(method, params) {
      return new Promise(res => {
        const id = nextId++;
        waiters[id] = res;
        child.stdin.write(framed({ jsonrpc: '2.0', id, method, params }));
      });
    }

    resolve({ child, send });
  });
}

(async () => {
  const { child, send } = await runMcp();

  console.log('[1] initialize');
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.1' }
  });
  assert(init.result && init.result.serverInfo && init.result.serverInfo.name === 'meta-harness', 'serverInfo.name=meta-harness');

  // Notify initialized
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log('[2] tools/list');
  const list = await send('tools/list', {});
  assert(list.result && Array.isArray(list.result.tools), 'tools array returned');
  const names = list.result.tools.map(t => t.name);
  for (const expected of ['fleet_list_agents', 'fleet_submit_mission', 'fleet_mission_status']) {
    assert(names.includes(expected), `tool ${expected} advertised`);
  }

  console.log('[3] tools/call fleet_list_agents');
  const call = await send('tools/call', { name: 'fleet_list_agents', arguments: {} });
  assert(call.result && Array.isArray(call.result.content), 'tool call returned content');
  const text = call.result.content[0].text || '';
  assert(text.includes('"agents"'), 'response mentions "agents"');
  assert(text.includes('"backend"'), 'backend appears in registered agents');

  console.log('[4] tools/call fleet_submit_mission');
  const submit = await send('tools/call', {
    name: 'fleet_submit_mission',
    arguments: { title: 'MCP smoke', brief: 'Build an API endpoint through MCP' }
  });
  const subText = submit.result && submit.result.content && submit.result.content[0] && submit.result.content[0].text;
  assert(subText && subText.includes('missionId'), 'fleet_submit_mission returned missionId');

  child.kill();
  console.log('\nALL PHASE 1h SMOKE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
