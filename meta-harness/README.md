# Meta Harness

Local orchestration layer above the 11-agent Fleet. Implements the five Super Harness architectural layers — **Protocol**, **Identity & Trust**, **Discovery**, **Orchestration**, **Safety & Governance** — and exposes the whole thing to external MCP clients.

Runs as a separate service on port **20000**. Deleting this directory leaves the Fleet Command Dashboard (`.fleet/`) fully functional — everything here is opt-in.

## Quick start

**Windows (cmd.exe)**:

```cmd
set META_HARNESS_ADMIN_TOKEN=your-token  &&  scripts\start-all.bat
:: or pass as arg:  scripts\start-all.bat your-token
```

**Windows (PowerShell)** — PowerShell's `set` doesn't export to the environment, use `$env:` or pass the token as a parameter:

```powershell
$env:META_HARNESS_ADMIN_TOKEN = "your-token"
.\scripts\start-all.ps1
# or:
.\scripts\start-all.ps1 -AdminToken your-token
```

Both launchers spawn two minimized windows — one for the service on :20000, one for the broker. Stop everything with `scripts\stop-all.bat` or `.\scripts\stop-all.ps1`. Logs land in `meta-harness\data\logs\meta-harness.log` and `meta-broker.log`.

**macOS / Linux / Git Bash**:

```bash
cd meta-harness && npm install                      # one-time
export META_HARNESS_ADMIN_TOKEN=your-token
bash scripts/start-all.sh                           # starts service + broker in background
```

## Registering your own agent

The 11 fleet agents auto-register via the broker. For an external agent (your own service, a webhook bot, a different model provider):

### Full guided onboarding (recommended for new users)

Walks through pre-flight checks, keypair generation, token minting, registration, verification, an optional protocol round-trip, and writes a personalised runbook you can follow to wire up your agent process.

```powershell
# PowerShell
$env:META_HARNESS_ADMIN_TOKEN = "your-token"
.\scripts\onboard-agent.ps1 my-agent --caps "summarize,translate" --model sonnet --simulate --runtime daemon
```

```bash
# bash
META_HARNESS_ADMIN_TOKEN=your-token bash scripts/onboard-agent.sh my-agent \
  --caps "summarize,translate" --simulate --runtime daemon
```

Flags: `--runtime daemon|broker|mcp|custom` shapes the runbook with runtime-specific next steps; `--simulate` runs a full end-to-end protocol round-trip (submits a mission, signs a lease request as your agent, completes it) so you know every hop works before wiring up your real process. Output lands at `data/agent-keys/<name>.onboarding.md` — a copy-paste-ready runbook with your actual keys, sample daemon code, and troubleshooting table.

### Low-level: just register (for CI or scripts)

If you know what you're doing and don't need the hand-holding:

```powershell
.\scripts\register-agent.ps1 my-agent --caps "summarize,translate" --public
```

Generates a keypair at [data/agent-keys/\<name\>.key](meta-harness/data/agent-keys/), mints a 24 h capability token, builds and signs the manifest, and POSTs `/v1/register`. Afterwards `GET /v1/agents` lists your agent.

To unregister: `.\scripts\unregister-agent.ps1 my-agent` (or `.sh`). Keypair is preserved unless you pass `--delete-key`; re-register later with `register-agent.ps1 my-agent --force`.

Options on both: `--caps`, `--model`, `--rpm`, `--ttl`, `--public`, `--force`, `--host`, `--port`. Run with `--help` for the full list.

### Self-service discovery URL

Before registering, any agent/user can hit the running harness to learn the full protocol:

- **Machine-readable**: [http://\<host\>:20000/v1/.well-known/agent-discovery](http://127.0.0.1:20000/v1/.well-known/agent-discovery) — JSON descriptor with every endpoint, schema, required skill, and auth path.
- **Human-readable**: [http://\<host\>:20000/v1/discovery/agent-guide](http://127.0.0.1:20000/v1/discovery/agent-guide) — full protocol walkthrough, copy-paste recipes, signature scheme, troubleshooting.
- **Raw markdown**: [http://\<host\>:20000/v1/discovery/agent-guide.md](http://127.0.0.1:20000/v1/discovery/agent-guide.md) — same content, for LLM/automated consumption.

**Manual (any OS)**, if you want to see live console output:

```bash
node bin/meta-harness.js                            # terminal 1: HTTP+WS on :20000
node bin/meta-broker.js                             # terminal 2: registers all .claude/agents/*.md and long-polls leases
node bin/meta-mcp.js                                # optional terminal 3: stdio MCP server
```

Open the operator console at [http://localhost:20000/ui/missions.html](http://localhost:20000/ui/missions.html). Submit a mission; the broker picks up the lease, spawns a `claude --agent <name>.md` session via [.fleet/launch-agent.sh](../.fleet/launch-agent.sh), the agent reads its command out of `.claude/agent-commands.json`, executes the task, logs complete, and the broker forwards the completion back to Meta Harness. Verification closes the loop.

**Requires the Claude CLI on PATH** for auto-launch. If the broker logs `Auto-launch: ON (claude CLI NOT found — manual launch required)`, install Claude Code (`npm install -g @anthropic-ai/claude-code`) or set `MH_AUTO_LAUNCH=0` and launch agents manually with `bash .fleet/launch-agent.sh <name>`.

Agent launch logs go to `meta-harness/data/logs/agent-launches/<agent>-<timestamp>.log` — one file per spawned session.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `META_HARNESS_ADMIN_TOKEN` | *unset = readonly* | Admin token, SHA-256-hashed to `data/admin-token.hash` on first boot |
| `META_HARNESS_PORT` | `20000` | HTTP + WebSocket port |
| `META_HARNESS_HOST` | `127.0.0.1` | Host the broker/MCP client dial |
| `MAX_CONCURRENT_PER_AGENT` | `1` | Lease concurrency cap per agent |
| `AUDIT_ROTATE_BYTES` | `52428800` | 50 MB rotation threshold |
| `MH_AUTO_LAUNCH` | `1` | Broker auto-spawns `claude --agent <name>.md` when it issues a lease. Set to `0` to keep the queue-only behaviour and launch agents manually. |
| `MH_REQUIRE_CREDENTIAL` | `0` | Reject TOFU registration; require a capability token on `/v1/register` |
| `MH_METRICS_CHECKPOINT_MS` | `60000` | Observability counter checkpoint interval |
| `MH_PEER_SCORE_PENALTY` | `0.7` | Multiplier on peer-agent discovery scores (0 disables federation discovery) |

## HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/status` | open | Readiness + mode |
| GET | `/v1/schemas/:name` | open | JSON-Schema retrieval |
| GET | `/v1/audit?since&limit` | open | Paginated audit trail (cursor = byte offset) |
| POST | `/v1/register` | admin + Ed25519 | TOFU-pin agent pubkey |
| GET | `/v1/agents` | open | Registered agents + liveness |
| GET | `/v1/agents/:name` | open | Single agent detail |
| POST | `/v1/missions` | admin | Submit mission |
| GET | `/v1/missions[/:id]` | open | List / read missions |
| POST | `/v1/missions/:id/cancel` | admin | Stop a single mission |
| POST | `/v1/agents/:name/lease` | Ed25519 | Long-poll for next subtask (30 s) |
| POST | `/v1/leases/:id/renew` | Ed25519 | Extend TTL |
| POST | `/v1/missions/:id/progress` | Ed25519 | Stream update |
| POST | `/v1/missions/:id/complete` | Ed25519 | Report done + artifacts |
| POST | `/v1/halt` | admin | Kill-switch |
| POST | `/v1/resume` | admin | Clear kill-switch |
| GET | `/v1/halt` | open | Current state |
| POST | `/v1/admin/reset-agent` | admin | Un-pin TOFU pubkey |
| WS | `/v1/events` | open | Live event stream |
| GET | `/v1/.well-known/agent-discovery` | open | Machine-readable service descriptor |
| GET | `/v1/discovery` | open | Same (alias) |
| GET | `/v1/discovery/agent-guide` | open | Human-readable agent protocol guide (HTML) |
| GET | `/v1/discovery/agent-guide.md` | open | Raw Markdown version for LLM consumption |
| GET | `/v1/trust/root` | open | Our trust-root pubkey + kid (peers bootstrap here) |
| POST | `/v1/admin/issue-token` | admin | Mint capability token |
| POST | `/v1/admin/revoke-token` | admin | Add token hash to revoked list |
| GET | `/v1/admin/trust-roots` | admin | List trusted-root pubkeys |
| POST | `/v1/admin/trust-roots` | admin | Add an external trust root |
| DELETE | `/v1/admin/trust-roots/:kid` | admin | Remove (non-self) trust root |
| GET | `/v1/metrics` | open | Prometheus-format metrics |
| GET | `/v1/metrics.json` | open | Same, as JSON |
| GET | `/v1/usage` | open | Aggregate metering (time-based estimate) |
| GET | `/v1/missions/:id/usage` | open | Per-mission metering |
| GET | `/v1/metering/rates` | open | Rate table (data/metering/rates.json) |
| POST | `/v1/peers` | admin | Add a federation peer + initial handshake |
| GET | `/v1/peers` | open | List peers |
| DELETE | `/v1/peers/:id` | admin | Remove peer |
| POST | `/v1/peers/:id/refresh` | admin | Re-handshake and refresh capabilities |
| POST | `/v1/federation/handshake` | capability token | Inbound peer handshake |
| GET | `/v1/federation/capabilities` | open | Our public capability index |

**Auth headers**: admin calls carry `X-Admin-Token: <token>`. Agent-signed calls carry `X-Agent-Name`, `X-Nonce`, `X-Issued-At`, `X-Signature` — signature is over canonical JSON of `{ ...body, _meta:{agent,nonce,issuedAt} }`.

## Layering

```
meta-harness/
├── bin/
│   ├── meta-harness.js   entrypoint — HTTP+WS
│   ├── meta-broker.js    persistent client that bridges Fleet <-> Meta Harness
│   └── meta-mcp.js       stdio MCP server
├── src/
│   ├── server.js              routing, admin-token middleware, WS fanout
│   ├── audit/log.js           append-only JSONL with rotation
│   ├── registry/
│   │   ├── identity.js        Ed25519 + canonical JSON + nonce replay + TOFU pin
│   │   ├── store.js           per-agent JSON persistence
│   │   └── routes.js          /v1/register, /v1/agents
│   ├── discovery/router.js    tf-idf capability match
│   ├── orchestrator/
│   │   ├── missionStore.js
│   │   ├── leases.js          issue, renew, sweep
│   │   ├── scheduler.js       ready-set, cascade-failure
│   │   ├── planner.js         bucket-based brief -> DAG (operator override supported)
│   │   ├── verify.js          file_exists | command_exit_zero | reviewer_tag
│   │   ├── sigCheck.js        signed-request helper
│   │   └── routes.js          missions, leases, progress, complete
│   ├── safety/
│   │   ├── adminToken.js      SHA-256 hashed at rest
│   │   ├── killswitch.js      persisted HALT flag
│   │   ├── ratelimit.js       token bucket per (agent,endpoint)
│   │   ├── policies.js        required-reviewer patterns, denylist
│   │   └── routes.js          halt, resume, cancel, reset-agent
│   ├── broker/
│   │   ├── main.js            long-poll multiplexer
│   │   ├── client.js          signed HTTP helper
│   │   ├── agentKeys.js       per-agent private keys (chmod 600)
│   │   ├── commandQueue.js    atomic writes to .claude/agent-commands.json
│   │   └── fleetLog.js        tails .claude/agent-activity.log
│   ├── adapters/
│   │   └── dashboardProjection.js  mirrors events into .claude/agent-activity.log
│   ├── mcp/tools.js           3 tools: list_agents, submit_mission, mission_status
│   ├── schemas/*.schema.json  Ajv-validated
│   ├── ws/events.js           /v1/events fanout with per-connection rate cap
│   └── ui/missions.html       operator console
├── data/                      runtime state (gitignored)
│   ├── registry/              public pubkey pins
│   ├── broker-keys/           private keys (chmod 600)
│   ├── missions/
│   ├── leases/
│   ├── audit/                 audit.jsonl + rotated files
│   ├── killswitch.flag
│   └── admin-token.hash
└── test/
    ├── smoke-register.js      Phase 1b: 5 assertions
    ├── smoke-mission.js       Phase 1a-1e: 18 assertions
    ├── smoke-broker.js        Phase 1f: 8 assertions
    └── smoke-mcp.js           Phase 1h: 10 assertions
```

## Zero-coupling guarantee

Meta Harness communicates with the existing Fleet through exactly two filesystem primitives:

1. **Appends** lines to [.claude/agent-activity.log](../.claude/agent-activity.log) via the public [.fleet/log-agent-activity.sh](../.fleet/log-agent-activity.sh) script so the 3D dashboard visualizes its activity automatically.
2. **Atomic tmp-rename writes** to [.claude/agent-commands.json](../.claude/agent-commands.json), matching the pattern in [.fleet/agent-bridge.js](../.fleet/agent-bridge.js).

No JavaScript imports cross between `.fleet/` and `meta-harness/`. Stop the meta-harness process and the Fleet behaves exactly as it did before.

## Phase 2 — what changed

- **Capability tokens** replace TOFU as the primary identity path. A trust root auto-generates at [data/trust/root.secret.key](meta-harness/data/trust/root.secret.key) on first boot. Admin mints short-lived Ed25519 credentials via `/v1/admin/issue-token`, and agents present them on register. A valid credential **overrides** a pinned pubkey — no more DoS-by-name-squatting. Set `MH_REQUIRE_CREDENTIAL=1` to refuse the legacy TOFU+admin path entirely.
- **Observability** is live. Prometheus text at `/v1/metrics`, JSON at `/v1/metrics.json`. Counters checkpointed every minute so restarts don't reset totals. Missions UI now has a Health strip.
- **Metering**. Every completion (success or fail) carries a `meter` block in the audit entry: `leaseStart/End`, `leaseHeldMs`, `agent`, `model`, `estCostCents`, `estCostReason`. Unknown model → `null` cost with reason — never silently zero. `/v1/usage` aggregates; Missions UI has a Usage tab.
- **Federated discovery**. Two harnesses exchange capability indexes via `/v1/federation/handshake`. `peerId = sha256(trustRoot)[:16]` so peers can't be forged by name. Peer-agent tf-idf scores are multiplied by `MH_PEER_SCORE_PENALTY` (default 0.7) so local always wins ties. Cross-harness *execution* is deferred to Phase 3 — assigning a `peer:<id>` agent returns 501 honestly.

## Known Phase-2 constraints (call out for future work)

- **Trust bootstrap is TOFU'd out-of-band** — operator types the peer's trust-root pubkey into `POST /v1/peers`. Verified on handshake, but if that initial value is wrong, the whole peer is wrong. Production needs DNS-based discovery or a directory service.
- **Credentials are not W3C VCs** — shape is compatible but the semantics aren't strictly spec-compliant. Upgrade path is clear.
- **Metering is time-based, not token-based** — "cost" = `leaseHeldMs × modelRate`. Labeled as estimate throughout. Will switch to real tokens when Claude CLI exposes usage counts.
- **Federation execution deferred** — discovery only. To run work on a peer's agent, submit the mission on that peer directly.
- **Verification is only as strong as the spec**: `command_exit_zero` is the default; `file_exists` is explicit trust-me mode.
- **Rule-based planner**: no LLM in the planning loop. Operators who want richer decomposition can POST an explicit DAG.
- **Windows file locking**: broker uses tmp-rename atomic writes for the command queue.
