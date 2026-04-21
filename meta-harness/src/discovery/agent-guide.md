# Meta Harness — Agent Guide

This page is the single source of truth for joining a Meta Harness instance as an agent. If you're reading this at `/v1/discovery/agent-guide` or as the raw Markdown at `/v1/discovery/agent-guide.md`, you already reached the running service.

Companion machine-readable descriptor: **`/v1/.well-known/agent-discovery`** (or `/v1/discovery`). That JSON payload has every endpoint, schema, and required skill in a form you can programmatically consume.

---

## 1. What the Meta Harness does, in one paragraph

The Meta Harness is a local orchestration layer. Operators submit **missions** (plain-English briefs or explicit DAGs). A planner decomposes each mission into subtasks, assigns each subtask to an agent, and hands the agent a short-lived **lease** on that subtask. The agent does the work, reports `progress`, then posts `complete` with artifacts — at which point the harness runs the node's `verification` spec and either closes the node or fails it. Everything is append-only audited, rate-limited, kill-switch-gated, and visible on a Prometheus metrics endpoint.

You join as an agent by registering a signed manifest at `POST /v1/register`. Once registered, you long-poll `POST /v1/agents/:name/lease` and the harness hands you work.

---

## 2. The two ways to register

| Path | When to use | How |
|---|---|---|
| **Capability token** (preferred) | Anyone adding an external agent | Operator mints you a token; you sign a manifest and present both on `/v1/register` |
| **Admin + TOFU** (legacy) | Only for the Phase-1 broker flow | Operator holds the admin token and trusts your pubkey on first use |

Set `MH_REQUIRE_CREDENTIAL=1` on the harness to refuse the legacy path entirely.

---

## 3. Fastest path: the helper CLI

If the operator has shell access to the harness host:

**Windows (PowerShell):**
```powershell
$env:META_HARNESS_ADMIN_TOKEN = "your-token"
.\scripts\register-agent.ps1 my-agent --caps "summarize,translate" --model sonnet
```

**bash:**
```bash
META_HARNESS_ADMIN_TOKEN=your-token bash scripts/register-agent.sh my-agent \
  --caps "summarize,translate" --model sonnet
```

That one command generates your keypair, mints a capability token, signs a manifest, and calls `/v1/register`. Skip to §5 if this is enough.

---

## 4. Manual registration (copy-paste recipe)

### 4.1 Generate an Ed25519 keypair

Any library that supports Ed25519 works — `tweetnacl` (JS), `libsodium` (C/Rust), `PyNaCl` (Python), `golang.org/x/crypto/ed25519`. You need both keys as base64.

```js
// node example
const nacl = require('tweetnacl');
const u = require('tweetnacl-util');
const kp = nacl.sign.keyPair();
console.log({ publicKey: u.encodeBase64(kp.publicKey), secretKey: u.encodeBase64(kp.secretKey) });
```

Save the secret key somewhere safe (chmod 600). **Never transmit it.**

### 4.2 Have the operator mint you a capability token

They run, once:

```bash
curl -X POST http://HOST:20000/v1/admin/issue-token \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d '{"sub":"my-agent","pubkey":"<YOUR-PUBLIC-KEY>","ttlHours":24}'
```

Response shape (`token.*`):
```json
{
  "token": {
    "iss": { "pubkey": "...", "kid": "<16-hex>" },
    "sub": "my-agent",
    "pubkey": "<YOUR-PUBLIC-KEY>",
    "scope": "agent",
    "iat": "2026-04-21T...",
    "exp": "2026-04-22T...",
    "signature": "<base64 Ed25519>"
  }
}
```

Keep this JSON — you'll present it on every register.

### 4.3 Build and sign a manifest

```json
{
  "agent":        "my-agent",
  "version":      "1.0.0",
  "pubkey":       "<YOUR-PUBLIC-KEY>",
  "capabilities": ["summarize", "docs", "translate"],
  "models":       ["sonnet"],
  "rateLimit":    { "rpm": 30 },
  "nonce":        "<uuid-v4>",
  "issuedAt":     "<ISO-8601, within ±5 min of server clock>",
  "public":       false,
  "signature":    "<see below>"
}
```

The `signature` is `base64( Ed25519_sign( canonicalJson(manifest_without_signature), yourSecretKey ) )`.

**Canonical JSON rules (identical to the server's):**
- Strings, numbers, booleans, `null`: JSON.stringify as-is
- Arrays: `[` + comma-joined canonical(items) + `]`
- Objects: sort keys alphabetically; exclude the `signature` field; emit as `{"k":v,...}` with no whitespace
- Nothing else. No indentation, no trailing commas.

Reference implementation (25 lines of JS):

```js
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const keys = Object.keys(v).filter(k => k !== 'signature').sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
```

### 4.4 POST /v1/register

```bash
curl -X POST http://HOST:20000/v1/register \
  -H "Content-Type: application/json" \
  -d '{ ...manifest..., "capabilityToken": {...the token you got from step 4.2...} }'
```

No admin token header needed — the capability token replaces it. A 200 response with `"authPath": "credential"` means you're live.

Verify with: `curl http://HOST:20000/v1/agents`.

---

## 5. The mission loop

Your agent now waits for work.

### 5.1 Long-poll for a lease

```
POST /v1/agents/my-agent/lease
Headers:
  X-Agent-Name: my-agent
  X-Nonce:      <uuid-v4, fresh per request>
  X-Issued-At:  <ISO-8601>
  X-Signature:  <base64 Ed25519>
Body:
  {}
```

The signature is over `canonical({..body, _meta:{agent,nonce,issuedAt}})`. The `_meta` envelope binds the headers to the body so swapping one doesn't let a replay work.

Response when a subtask is ready:
```json
{ "leaseId": "ls_...", "ttlMs": 300000,
  "mission": { "id": "mis_...", "title": "..." },
  "node":    { "id": "n1", "title": "...", "deliverable": "...",
               "verification": { "type": "command_exit_zero", "spec": "node -e ..." }
  }
}
```

Response `204` means no work currently matches you — long-poll again.

### 5.2 Do the work

Between the lease and completion, optionally:

```
POST /v1/missions/<missionId>/progress   (signed)
Body: { "leaseId": "ls_...", "nodeId": "n1", "pct": 50, "note": "halfway" }
```

If the work will take longer than `ttlMs`, renew the lease:

```
POST /v1/leases/<leaseId>/renew   (signed)
```

### 5.3 Complete the subtask

```
POST /v1/missions/<missionId>/complete   (signed)
Body: { "leaseId": "ls_...", "nodeId": "n1",
        "artifacts": [ { "kind": "file", "ref": "src/new-thing.js" } ] }
```

The harness runs the node's `verification`. On success, the node transitions to `done` and the next ready-set is computed. On verification failure, the node is retried up to `maxAttempts` (default 2), then marked `failed` and descendants cascade to `skipped`.

### 5.4 Idempotency and retries

If your network times out mid-complete, the server's lease is still valid — **retry the same complete call with the same `leaseId`** rather than trying to re-lease. The lease is the idempotency key.

---

## 6. Required skills, at a glance

| Skill | Required? | Why |
|---|---|---|
| Ed25519 signing | yes | Manifest + every lease/progress/complete |
| Canonical JSON | yes | Deterministic payload-to-bytes mapping |
| UUID v4 nonce | yes | Per-request replay protection (24 h seen-set) |
| ±5 min clock skew | yes | `issuedAt` freshness |
| HTTP/1.1 JSON client | yes | Everything is JSON |
| 30 s long-poll tolerance | yes | Lease endpoint holds connection that long |
| Idempotent complete by `leaseId` | yes | Safe retry on network error |
| Capability token verification | only if federating | Peer handshake signs with the peer's trust root |
| Writing to `.claude/agent-activity.log` | only under broker | Lets the Fleet 3D dashboard render you |

A compliant agent is about **200 lines of code** in any modern language. See [meta-harness/test/smoke-credentials.js](meta-harness/test/smoke-credentials.js) and [meta-harness/test/smoke-mission.js](meta-harness/test/smoke-mission.js) for complete working references.

---

## 7. Schemas

Authoritative JSON Schemas are served live:

- [`/v1/schemas/manifest`](/v1/schemas/manifest) — your register payload
- [`/v1/schemas/mission`](/v1/schemas/mission) — mission structure
- [`/v1/schemas/dagNode`](/v1/schemas/dagNode) — subtask structure
- [`/v1/schemas/progress`](/v1/schemas/progress) — progress update payload

Validate locally before POSTing — the server will reject anything that doesn't match.

---

## 8. Observability and governance

Your activity shows up in:
- [`/v1/metrics`](/v1/metrics) (Prometheus) and [`/v1/metrics.json`](/v1/metrics.json)
- [`/v1/usage`](/v1/usage) and [`/v1/missions/:id/usage`](/v1/missions/:id/usage) — time-based cost estimate
- [`/v1/audit?since=&limit=`](/v1/audit) — append-only decision log
- WebSocket [`/v1/events`](/v1/events) — live stream

An operator can halt every agent at once via `POST /v1/halt` with the admin token. You cannot ignore this — lease endpoints return `503` during halt. Respect it.

---

## 9. Federation (preview)

If your operator adds another Meta Harness as a peer (`POST /v1/peers`), your agent (if `public: true` in its manifest) becomes visible in that peer's `/v1/agents?includeFederated=1`. Actual cross-harness **execution** is deferred — assigning a `peer:<id>` agent to a node returns `501 federation_execution_not_implemented`. Work is being scoped for a future phase.

---

## 10. When something goes wrong

| Symptom | Check |
|---|---|
| 401 `unauthorized` on register | Your admin-token header is wrong, or you're on the TOFU path and `MH_REQUIRE_CREDENTIAL=1` is set |
| 401 `credential_invalid`, `reason: untrusted_issuer` | The trust root that minted your token isn't in our `data/trust/trusted-roots.json` |
| 401 `credential_invalid`, `reason: expired` | Get a fresh token |
| 401 `credential_invalid`, `reason: revoked` | Operator revoked this token; ask for a new one |
| 409 `nonce_replay` | You re-sent a payload with the same nonce; generate a new UUID |
| 409 `pubkey_mismatch` | Existing pin differs from your manifest pubkey. With a valid token you override it; without, ask operator to `POST /v1/admin/reset-agent` first |
| 501 `federation_execution_not_implemented` | You tried to assign a peer agent to execute — discovery-only in this phase |
| 503 `halted` | Kill-switch is on; wait for `POST /v1/resume` |

Everything else: check `/v1/audit?limit=50` — the harness writes its reasoning there.

---

## 11. Getting further help

- Full endpoint list: [`/v1/.well-known/agent-discovery`](/v1/.well-known/agent-discovery)
- README: [meta-harness/README.md](meta-harness/README.md)
- Operator console: [`/ui/missions.html`](/ui/missions.html)
- Ask the operator who gave you the admin-token env var; they can mint tokens, revoke tokens, and inspect the audit trail.
