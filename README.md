# Meta Harness

A local, runnable implementation of the [Global AI Super Harness](https://kennethraj.net/page.php?slug=global-ai-super-harness) architecture. Operators submit high‑level missions; an orchestrator decomposes them, dispatches subtasks to the right agent, enforces policy, and exposes the whole fleet to any MCP client.

Phases 1 and 2 of the article's roadmap are implemented and runnable on a laptop. Cross‑organisation federation is stubbed and called out honestly as Phase 3.

---

## What this is

The Super Harness thesis is that AI agents will only realise their potential when they can **discover, authenticate, collaborate with, and pay for** capabilities owned by any other party — without a single vendor acting as a gatekeeper. That's a planetary‑scale aspiration; this repo is a minimum viable version of the same architecture scaled down to one project you can run locally.

Concretely: a Node.js service on port 20000 speaking a versioned HTTP + WebSocket protocol, an Ed25519‑signed credential system, a tf‑idf discovery router, a DAG orchestrator with leased subtasks and automatic retries, a Prometheus observability endpoint, a time‑based metering ledger, and a federated peer handshake. Plus a self-describing `/v1/discovery` URL so any agent can bootstrap without external docs.

The repo also ships a small Claude Code fleet (11 specialised agents and a 3D command dashboard) that the Meta Harness auto‑drives — giving you a working end‑to‑end system the instant you clone.

---

## What's in this repo

```
AISuperHarness/
├── meta-harness/       the orchestration service (Phase 1 + 2) — this is the new thing
│   ├── bin/            entrypoints: harness, broker, MCP stdio server
│   ├── src/            5 layers: protocol, identity, discovery, orchestration, safety
│   │                   + observability, metering, federation, credentials, adapters
│   ├── scripts/        onboard-agent, register-agent, start-all, run-all-tests
│   ├── test/           8 smoke-test files (90+ assertions)
│   └── README.md       service-level docs, full endpoint table, env vars
│
├── .claude/agents/     11 agent definitions (architect, backend, frontend, database,
│                       qa, security, reviewer, devops, perf, docs, researcher).
│                       The broker auto-registers and auto-launches these.
│
├── .fleet/             3D command dashboard (standalone, predates Meta Harness).
│                       Meta Harness projects its events into the fleet log so the
│                       dashboard visualises orchestration activity automatically.
│
├── research/           mission-produced research briefs (see "Origins" below)
│
└── CLAUDE.md           operator overview of the full project
```

---

## Quick start

Requires **Node.js 18+** and (for the auto-launch path) the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code).

### Windows (PowerShell)

```powershell
git clone https://github.com/kennethrajsimon/meta-harness.git
cd meta-harness\meta-harness
npm install

$env:META_HARNESS_ADMIN_TOKEN = "your-token"
.\scripts\start-all.ps1
```

### macOS / Linux / Git Bash

```bash
git clone https://github.com/kennethrajsimon/meta-harness.git
cd meta-harness/meta-harness
npm install

export META_HARNESS_ADMIN_TOKEN=your-token
bash scripts/start-all.sh
```

Then open:

| URL | What you see |
|---|---|
| http://localhost:20000/ui/missions.html | Operator console — submit missions, watch DAGs execute, halt/resume, view live events |
| http://localhost:20000/v1/discovery/agent-guide | Full protocol walkthrough any agent or developer can read to bootstrap |
| http://localhost:20000/v1/metrics | Prometheus metrics |
| http://localhost:20000/.well-known/agent-discovery | Machine-readable service descriptor |

Submit a mission from the UI — e.g. title "Health endpoint", brief "Add a `/v1/health` route that returns `{status:'ok'}`" — and watch the broker auto-launch the backend agent, execute, complete, and verify.

---

## Architecture, in one diagram

```
  ┌──────────────┐      POST /v1/missions                 ┌───────────────────┐
  │   Operator   │ ───────────────────────────────────▶   │   Meta Harness    │
  │  (UI / curl) │                                         │    :20000         │
  │   / MCP      │ ◀──── /v1/events (WS) ──────────────    │                   │
  └──────────────┘                                         │  ┌──Planner────┐  │
                                                           │  │ Scheduler   │  │
                                                           │  │ Leases      │  │
                                                           │  │ Verifier    │  │
  ┌──────────────┐                                         │  └─────────────┘  │
  │  MCP client  │ ──── stdio (fleet_submit_mission) ──▶   │                   │
  │  (Claude     │                                         │  ┌──Credentials┐  │
  │   Desktop…)  │                                         │  │ Identity    │  │
  └──────────────┘                                         │  │ TrustRoot   │  │
                                                           │  │ Revocation  │  │
                                                           │  └─────────────┘  │
                                                           │                   │
                                                           │  ┌──Observability│
                                                           │  │ Metering     │ │
                                                           │  │ Federation   │ │
                                                           │  │ Audit        │ │
                                                           │  └────────────┘   │
                                                           └─────────┬─────────┘
                                                                     │ POST /v1/agents/:name/lease
                                                                     │ (Ed25519 signed, long-poll)
                                                                     ▼
                                                           ┌────────────────────┐
                                                           │      Broker        │
                                                           │  (persistent loop) │
                                                           └─────────┬──────────┘
                                                                     │ writes .claude/agent-commands.json
                                                                     │ spawns `claude --agent backend.md`
                                                                     ▼
  ┌──────────────────┐      writes .claude/agent-activity.log     ┌────────────┐
  │  Fleet Dashboard │ ◀─────────────────────────────────────── ── │  Agent     │
  │     :27182       │                                             │  (Claude   │
  │   (3D scene)     │                                             │   Code)    │
  └──────────────────┘                                             └────────────┘
```

The broker is the critical piece: it makes Claude Code's transient subagents participate in the long‑poll lease protocol without any modification to the agents themselves. Deleting `meta-harness/` leaves the fleet dashboard working identically — zero coupling.

---

## What's implemented

Five architectural layers from the article, all live:

| Layer | Implementation |
|---|---|
| **Universal Protocol** | HTTP + WebSocket on `:20000`, versioned `/v1/*`, Ajv‑validated JSON schemas served at [`/v1/schemas/:name`](meta-harness/src/schemas/) |
| **Identity & Trust** | Ed25519 with canonical JSON; TOFU pubkey pinning + Ed25519 capability tokens signed by an operator‑owned trust root. Nonce replay guard. Short‑TTL tokens, revocation list, `/v1/admin/issue-token` + `/v1/admin/revoke-token`. |
| **Discovery** | tf‑idf capability router over the registry; federated peer capability indexes via `/v1/peers` + handshake. Peer scores score‑penalised so local always wins ties. |
| **Orchestration** | Mission DAGs, 5‑minute leases with auto‑sweep + renew, per‑agent FIFO scheduler, cascade‑failure semantics, three verification modes (`file_exists`, `command_exit_zero`, `reviewer_tag`). |
| **Safety & Governance** | SHA‑256‑hashed admin token (plaintext never persisted), persisted kill‑switch, token‑bucket rate limits, policy engine (required‑reviewer tags, denylist), mission cancel, append‑only audit log with rotation. |

Plus:

- **Broker** ([meta-harness/src/broker/](meta-harness/src/broker/)) — one persistent process that multiplexes long‑polls for all agents, auto‑launches `claude --agent <name>.md` on lease, tails the fleet log for completions. Self‑healing re‑registration on `unknown_agent`.
- **MCP stdio server** ([meta-harness/bin/meta-mcp.js](meta-harness/bin/meta-mcp.js)) — exposes the fleet via three tools (`fleet_list_agents`, `fleet_submit_mission`, `fleet_mission_status`) to Claude Desktop, Cursor, or any MCP client.
- **Observability** ([meta-harness/src/observability/](meta-harness/src/observability/)) — Prometheus text at `/v1/metrics`, JSON at `/v1/metrics.json`, 60s checkpoint so restarts preserve counters.
- **Metering** ([meta-harness/src/metering/](meta-harness/src/metering/)) — time-based cost estimate per mission/agent/model, unknown models return null cost with a reason (never silently zero), audit reader traverses rolled files.
- **Federated discovery** ([meta-harness/src/federation/](meta-harness/src/federation/)) — peer handshake, `peerId = sha256(trustRoot)[:16]` so operators can't forge it. Cross‑harness **execution** is deferred and returns `501 federation_execution_not_implemented` honestly.
- **Discovery URL** ([meta-harness/src/discovery/](meta-harness/src/discovery/)) — `/v1/.well-known/agent-discovery` (JSON) + `/v1/discovery/agent-guide` (HTML) + `.md` (for LLMs) so any agent can self-onboard.
- **Guided onboarding CLI** ([meta-harness/scripts/onboard-agent.js](meta-harness/scripts/onboard-agent.js)) — 8-step walkthrough (pre-flight, keygen, token, register, verify, optional protocol round-trip, runbook generation).

90+ smoke-test assertions across [meta-harness/test/](meta-harness/test/) exercise every layer end-to-end. Run with `bash meta-harness/scripts/run-all-tests.sh`.

---

## What's deferred (Phase 3+)

Listed honestly in [meta-harness/README.md](meta-harness/README.md#known-phase-2-constraints):

- Cross‑harness **mission execution** (today: discovery only)
- Kill‑switch propagation across peers
- Background peer re‑sync loop (today: on‑demand via `/refresh`)
- W3C Verifiable Credentials strict conformance (current format is VC‑shaped but not spec‑compliant)
- Real token‑count metering (awaits Claude CLI exposing usage; current is leaseHeldMs × rate)
- LLM-based mission planner (current is rule-based; operators can always POST an explicit DAG)
- Distributed identity bootstrap without out‑of‑band trust‑root exchange

---

## Onboarding a custom agent

Most use cases don't need a custom agent — the 11 Claude Code agents cover common roles. If you do need one (a webhook bot, a Python service, a different model provider):

```powershell
# PowerShell
$env:META_HARNESS_ADMIN_TOKEN = "your-token"
.\meta-harness\scripts\onboard-agent.ps1 my-agent --caps "summarize,translate" --simulate --runtime daemon
```

The onboarding CLI runs eight checks (auth, name availability, keypair, token, register, verify, optional round-trip, runbook generation) and writes a personalised runbook at `meta-harness/data/agent-keys/<name>.onboarding.md` with runtime-specific next steps, a working daemon template, troubleshooting, and your actual keys filled in.

Or read the full protocol at http://localhost:20000/v1/discovery/agent-guide — it's authoritative and served live from the running service.

---

## Testing

```bash
cd meta-harness
META_HARNESS_ADMIN_TOKEN=test-token-abc bash scripts/run-all-tests.sh
```

Runs 8 smoke files in sequence against a live harness + broker:

1. `smoke-register` — Phase 1b: identity, TOFU, nonce replay
2. `smoke-mission` — Phase 1a–1e: full orchestration path
3. `smoke-broker` — Phase 1f: fleet log bridge
4. `smoke-mcp` — Phase 1h: MCP stdio server
5. `smoke-credentials` — Phase 2.1: capability tokens, TOFU override, revocation
6. `smoke-metrics` — Phase 2.2: Prometheus + JSON + killswitch gauge
7. `smoke-metering` — Phase 2.3: meter field, rate table, rolled-file audit reader
8. `smoke-federation` — Phase 2.4: peer handshake, discovery, 501 on execution

Expected output: `ALL SMOKE TESTS PASSED`.

---

## Origins

The architecture is Kenneth Raj Simon's, described at [kennethraj.net/page.php?slug=global-ai-super-harness](https://kennethraj.net/page.php?slug=global-ai-super-harness). This repo is a local implementation of that vision.

Phase 2 (capability tokens, federation, metering, observability) was designed in response to a research brief produced by the `docs` agent itself during a mission — a nice loop where the harness identified its own next priorities. The brief is at [research/super-harness-responsibilities.md](research/super-harness-responsibilities.md).

---

## License

TBD — see [LICENSE](LICENSE) (not yet added). If you're integrating this into something, please open an issue for licensing clarification.

---

## Contributing

This is Phase 1 + 2 of a longer arc. Issues welcome for:

- **Phase 3 scoping**: cross-harness execution semantics, kill-switch propagation, peer re-sync policy
- **Protocol hardening**: moving the credential format toward strict W3C VC conformance
- **Real-token metering**: once Claude CLI exposes usage, patching `src/metering/rates.js` to use it
- **Non-Claude agents**: adapters for OpenAI Assistants API, custom webhooks, etc.

The test suite is the contract — if a change breaks assertions in `meta-harness/test/`, the change is the problem, not the test.
