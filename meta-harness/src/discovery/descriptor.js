// Service descriptor — one JSON object describing everything an agent needs
// to bootstrap: auth paths, endpoints, schemas, required skills, signature
// scheme, and links to helper scripts. Built fresh on each request so the
// trust-root pubkey + port reflect current config.

const os = require('os');
const trust = require('../credentials/trustAnchors');

function build({ port = 20000, host = null } = {}) {
  const root = trust.ensureRoot();
  const effectiveHost = host || os.hostname();
  const baseUrl = `http://${effectiveHost}:${port}`;

  return {
    service: 'meta-harness',
    version: '0.1.0',
    specification: 'Super Harness — local Phase-2 implementation',
    baseUrl,
    generatedAt: new Date().toISOString(),

    trustRoot: {
      pubkey: root.publicKey,
      kid: root.kid,
      fetchAt: '/v1/trust/root'
    },

    authMethods: [
      {
        name: 'capability_token',
        preferred: true,
        description: 'Agent presents an Ed25519-signed capability token minted by a trust root we recognise. Overrides any prior TOFU pin for the same agent name. No admin token required on /v1/register when present.',
        mintedVia: 'POST /v1/admin/issue-token (admin only)',
        tokenShape: {
          iss: { pubkey: 'base64 Ed25519 pubkey of issuer', kid: 'sha256(pubkey)[:16]' },
          sub: 'agent name',
          pubkey: 'agent pubkey',
          scope: 'agent',
          iat: 'ISO-8601',
          exp: 'ISO-8601',
          signature: 'base64 Ed25519 over canonical(token without signature)'
        }
      },
      {
        name: 'admin_tofu',
        preferred: false,
        deprecated: false,
        description: 'Legacy path: X-Admin-Token header + trust-on-first-use pubkey pinning. Retained for backward compatibility. Refused if MH_REQUIRE_CREDENTIAL=1.',
        header: 'X-Admin-Token'
      }
    ],

    endpoints: {
      status:       { method: 'GET',  path: '/v1/status',                              auth: 'open' },
      schemas:      { method: 'GET',  path: '/v1/schemas/:name',                       auth: 'open', names: ['manifest', 'mission', 'dagNode', 'progress'] },
      trustRoot:    { method: 'GET',  path: '/v1/trust/root',                          auth: 'open' },
      register:     { method: 'POST', path: '/v1/register',                            auth: 'capability_token | admin_tofu' },
      agents:       { method: 'GET',  path: '/v1/agents',                              auth: 'open', query: ['includeFederated=1'] },
      missions:     { method: 'POST', path: '/v1/missions',                            auth: 'admin' },
      leasePoll:    { method: 'POST', path: '/v1/agents/:name/lease',                  auth: 'ed25519_signed', longPoll: '30s' },
      leaseRenew:   { method: 'POST', path: '/v1/leases/:id/renew',                    auth: 'ed25519_signed' },
      progress:     { method: 'POST', path: '/v1/missions/:id/progress',               auth: 'ed25519_signed' },
      complete:     { method: 'POST', path: '/v1/missions/:id/complete',               auth: 'ed25519_signed' },
      metrics:      { method: 'GET',  path: '/v1/metrics',                             auth: 'open', format: 'prometheus+json' },
      usage:        { method: 'GET',  path: '/v1/usage',                               auth: 'open' },
      events:       { method: 'WS',   path: '/v1/events',                              auth: 'open' },
      federation:   { method: 'POST', path: '/v1/federation/handshake',                auth: 'capability_token' },
      capabilities: { method: 'GET',  path: '/v1/federation/capabilities',             auth: 'open' }
    },

    signatureScheme: {
      algorithm: 'Ed25519',
      canonicalization: 'sorted-keys JSON, signature field excluded',
      libraries: ['tweetnacl (JS)', 'libsodium', 'PyNaCl (Python)', 'golang.org/x/crypto/ed25519'],
      replayProtection: {
        nonce: 'uuid-v4, per-agent 24h seen-set',
        issuedAt: 'ISO-8601, clock skew ≤ 5 minutes',
        headerForm: ['X-Agent-Name', 'X-Nonce', 'X-Issued-At', 'X-Signature']
      }
    },

    requiredSkills: [
      { id: 'ed25519_signing',       required: true,  why: 'Sign manifest + every lease/progress/complete call.' },
      { id: 'canonical_json',        required: true,  why: 'Deterministic payload-to-bytes mapping so signatures verify.' },
      { id: 'uuid_v4',               required: true,  why: 'Per-request nonce to prevent replay.' },
      { id: 'iso8601_clock',         required: true,  why: '`issuedAt` must be within ±5 min of server wall clock.' },
      { id: 'http_json_client',      required: true,  why: 'All endpoints are JSON over HTTP/1.1; no WebSocket mandatory.' },
      { id: 'long_poll_30s',         required: true,  why: 'POST /v1/agents/:name/lease holds for up to 30 s.' },
      { id: 'idempotent_complete',   required: true,  why: 'Network retries must not complete twice; key by leaseId.' },
      { id: 'capability_token_verify', required: false, why: 'Needed only if federating with other harnesses.' },
      { id: 'fleet_activity_log',    required: false, why: 'If running under the Claude Code broker, log to .claude/agent-activity.log so the 3D dashboard renders you.' }
    ],

    registrationFlow: {
      preferred: 'capability_token',
      steps: [
        { step: 1, description: 'Operator or CI runs scripts/register-agent.js (see helpers), or follows the manual curl sequence in /v1/discovery/agent-guide.md.' },
        { step: 2, description: 'Agent generates an Ed25519 keypair; holds secret key locally (chmod 600).' },
        { step: 3, description: 'Agent obtains a capability token from the Meta Harness admin: POST /v1/admin/issue-token (admin only).' },
        { step: 4, description: 'Agent builds a manifest, signs it, and POSTs /v1/register with {...manifest, capabilityToken}. No admin token header needed on this call.' },
        { step: 5, description: 'On 200, the agent is live in /v1/agents and can long-poll /v1/agents/:name/lease.' }
      ]
    },

    missionWorkflow: {
      steps: [
        'POST /v1/agents/:name/lease (signed)  →  { leaseId, mission, node, ttlMs }',
        'POST /v1/missions/:id/progress (signed) as you make progress',
        'POST /v1/leases/:leaseId/renew (signed) if work takes > ttlMs',
        'POST /v1/missions/:id/complete (signed) with artifacts when done',
        'Meta Harness runs node.verification — on success the node transitions to `done`.'
      ],
      verificationTypes: ['file_exists', 'command_exit_zero', 'reviewer_tag']
    },

    federation: {
      bootstrap: 'GET /v1/trust/root on a peer you want to connect to → give your operator that pubkey → POST /v1/peers.',
      executionStatus: 'discovery only in this phase; cross-harness mission execution returns 501 with error=federation_execution_not_implemented (phase 3).'
    },

    helpers: {
      registerAgentJs:    'meta-harness/scripts/register-agent.js',
      registerAgentSh:    'meta-harness/scripts/register-agent.sh',
      registerAgentPs1:   'meta-harness/scripts/register-agent.ps1',
      unregisterAgentJs:  'meta-harness/scripts/unregister-agent.js',
      brokerForClaudeCode: 'meta-harness/bin/meta-broker.js (auto-registers .claude/agents/*.md and auto-launches Claude Code sessions)',
      mcpStdioServer:     'meta-harness/bin/meta-mcp.js (exposes the fleet to any MCP client)'
    },

    docs: {
      agentGuideMarkdown: '/v1/discovery/agent-guide.md',
      agentGuideHtml:     '/v1/discovery/agent-guide',
      missionsUi:         '/ui/missions.html',
      selfDescriptorJson: '/v1/.well-known/agent-discovery',
      readme:             'meta-harness/README.md'
    },

    contactOperator: 'The admin token is held by your local operator (env var META_HARNESS_ADMIN_TOKEN). Ask them to run register-agent.js on your behalf, or to hand you a one-off capability token via POST /v1/admin/issue-token.'
  };
}

module.exports = { build };
