#!/usr/bin/env node
// Meta Harness MCP bridge — stdio transport. Exposes the fleet to any MCP
// client (Claude Desktop, Cursor, etc). All tool calls go through the
// public Meta Harness HTTP API — the MCP process keeps no state.
//
// Env:
//   META_HARNESS_HOST         (default 127.0.0.1)
//   META_HARNESS_PORT         (default 20000)
//   META_HARNESS_ADMIN_TOKEN  (required for fleet_submit_mission)

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { tools } = require('../src/mcp/tools');

async function main() {
  const server = new Server(
    { name: 'meta-harness', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const t = tools.find(x => x.name === req.params.name);
    if (!t) return { content: [{ type: 'text', text: `unknown_tool: ${req.params.name}` }], isError: true };
    return t.handler(req.params.arguments || {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[meta-mcp] ready\n');
}

main().catch(e => {
  process.stderr.write(`[meta-mcp] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
