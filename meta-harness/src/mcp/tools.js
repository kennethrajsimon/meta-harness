// Three MCP tools that expose the fleet to any MCP-speaking client
// (Claude Desktop, etc). Every tool call goes through the public Meta
// Harness HTTP API — no direct imports of orchestrator internals.
//
//   fleet_list_agents    — registered agents + capabilities + status
//   fleet_submit_mission — {brief, title, autoReplan?, dag?} -> {missionId}
//   fleet_mission_status — {missionId} -> snapshot

const { buildClient } = require('../broker/client');

const HOST = process.env.META_HARNESS_HOST || '127.0.0.1';
const PORT = parseInt(process.env.META_HARNESS_PORT || '20000', 10);
const ADMIN_TOKEN = process.env.META_HARNESS_ADMIN_TOKEN;

const client = buildClient({ host: HOST, port: PORT, adminToken: ADMIN_TOKEN });

function unavailable(err) {
  return { content: [{ type: 'text', text: `fleet_unavailable: ${err.message || err}` }], isError: true };
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const tools = [
  {
    name: 'fleet_list_agents',
    description: 'List registered fleet agents with their capabilities, models, and liveness (lastSeen, inflight lease count). Use this first to see what the fleet can do before submitting a mission.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      try {
        const r = await client.request('GET', '/v1/agents', null);
        if (r.status !== 200) return textResult({ error: r.status, body: r.body });
        return textResult(r.body);
      } catch (e) { return unavailable(e); }
    }
  },
  {
    name: 'fleet_submit_mission',
    description: 'Submit a new mission to the fleet. Provide a brief plain-English description; the planner decomposes it into a DAG and dispatches subtasks to the best-matching agents. Returns the missionId.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human-readable title.' },
        brief: { type: 'string', description: 'What the fleet should do. Free text.' },
        autoReplan: { type: 'boolean', description: 'Rerun planner on failure. Default false.' }
      },
      required: ['title', 'brief'],
      additionalProperties: false
    },
    async handler(args) {
      if (!ADMIN_TOKEN) return textResult({ error: 'META_HARNESS_ADMIN_TOKEN not set in MCP server environment' });
      try {
        const r = await client.adminCall('POST', '/v1/missions', args);
        if (r.status !== 201) return textResult({ error: r.status, body: r.body });
        return textResult({ missionId: r.body.missionId, dag: r.body.mission.dag });
      } catch (e) { return unavailable(e); }
    }
  },
  {
    name: 'fleet_mission_status',
    description: 'Fetch the current state of a mission by id: status, DAG node states, artifacts, timestamps. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { missionId: { type: 'string', description: 'Mission id returned by fleet_submit_mission.' } },
      required: ['missionId'],
      additionalProperties: false
    },
    async handler(args) {
      try {
        const r = await client.request('GET', `/v1/missions/${encodeURIComponent(args.missionId)}`, null);
        if (r.status !== 200) return textResult({ error: r.status, body: r.body });
        return textResult(r.body);
      } catch (e) { return unavailable(e); }
    }
  }
];

module.exports = { tools };
