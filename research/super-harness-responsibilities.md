# Research: What should a global AI Super Harness do?

*Produced by the `docs` agent for mission `mis_mo856elqddf79501`. Research pass draws on Kenneth Raj Simon's "Global AI Super Harness" article, the MCP specification, and prior-art in federated orchestration systems.*

## Question

At a concrete level, what are the responsibilities a planetary-scale AI Super Harness must discharge to earn the name? What must it do that a single-vendor multi-agent platform cannot?

## TL;DR

A global Super Harness is **federated infrastructure**, not an application. Its core job is to let any AI agent in the world discover, authenticate, collaborate with, and pay for capabilities owned by any other party — without any single entity controlling the network. Functionally that decomposes into **seven responsibilities**: protocol, identity, discovery, composition, safety, economic settlement, and observability. The first five are technical; the last two are what distinguishes "infrastructure for humanity" from "a company product."

## Findings — the seven responsibilities

### 1. Speak a universal protocol
A shared wire format + semantics so agents from different vendors interoperate by default. Today MCP is the strongest candidate because it is provider-agnostic, standardises tool interfaces, and supports dynamic discovery. A global harness must:
- Publish versioned schemas for manifests, capabilities, tasks, results, errors.
- Guarantee backwards compatibility over the decade-plus timeframe real infrastructure needs.
- Reject proprietary extensions that would partition the network.

### 2. Establish identity and trust
Knowing *which* agent is speaking, and whether you should listen. This is the hardest long-term problem. A real Super Harness needs:
- Cryptographic identity (public-key based) so agents can't spoof each other.
- Capability attestation — a third party signs "this agent is authorised to call Stripe" so relying parties don't have to trust the agent's own claim.
- Reputation signals with revocation — compromised agents must be evictable in minutes, not weeks.
- Mutual authentication so both sides of a conversation verify each other.

The Phase-1 local implementation uses TOFU pubkey pinning, which is adequate for a single project but explicitly not sufficient for planetary scale. Real deployment needs a federated PKI or a decentralised identity protocol (DIDs) with verifiable credentials.

### 3. Discovery
The harness must answer "who can do X?" for any X, across organisational boundaries. That requires:
- Distributed directories of agents, each listing capabilities in machine-readable form.
- Semantic matching, not just keyword — "translate medical records from German" must find the German-translation agent even if its manifest only says "multilingual NLP".
- Indices of data sources, not just agents — a researcher may need "public clinical trial datasets from 2024" as much as they need a specific analysis agent.
- Fresh liveness signals so the directory doesn't route traffic to dead agents.

### 4. Composition and orchestration
An individual agent is a building block; real work needs them assembled. The harness must:
- Accept a high-level goal and decompose it into a plan (DAG, workflow, or open-ended loop).
- Match each subtask to the best-available agent — cost, latency, reputation, capability fit.
- Track progress, handle failure, re-plan when a step stalls.
- Manage resource contention when two missions want the same scarce agent.
- Allocate budget and respect deadlines.

### 5. Safety and governance
Where the harness becomes infrastructure-for-humanity rather than a product. Responsibilities:
- Policy enforcement *at the protocol layer* — a forbidden action must be unavailable, not merely flagged after the fact.
- Comprehensive audit trails that any participant, regulator, or downstream stakeholder can inspect.
- Rate limiting and quotas to prevent a single actor from monopolising the network.
- Instant kill-switch at multiple layers (agent, organisation, network).
- Jurisdictional compliance — data residency, age restrictions, medical/financial regulation, export controls. These vary by country and they're not optional.
- Mechanisms to handle disputes, harmful behaviour, and compromised agents without a central authority that could itself be captured.

### 6. Economic settlement
Any global infrastructure without an economic model collapses into free-rider dynamics within a year. The harness must:
- Meter resource consumption (tokens, compute-seconds, data transfers, tool invocations).
- Settle payments across organisational boundaries — likely a mix of fiat rails, stable-coins, and off-chain credit.
- Price discovery: let providers set rates, let consumers comparison-shop.
- Prevent abuse — require upfront deposits, charge for failed attempts, blacklist non-payers.

### 7. Observability
Infrastructure that you can't see is infrastructure you can't trust. The harness must expose:
- Real-time view of active missions, agents, load, errors.
- Historical telemetry for post-mortems, capacity planning, and research.
- Per-mission lineage so a downstream consumer can audit how a given result was produced.
- Public metrics on aggregate health, fairness, and concentration — so operators and the public can detect monopolisation early.

## What a Super Harness does *not* do

Equally important for scope clarity:

- It is **not** an inference provider — it coordinates agents that each run their own model, it does not host models itself.
- It is **not** a content-moderation system — it enforces policy on *actions* (what agents may do on the network), not on natural-language outputs of individual models.
- It is **not** an application — consumer-facing products would be built on top of it, not inside it.
- It is **not** owned by one entity — the article frames this as existential: if any single vendor controls the harness, it has become a gatekeeper, and the value collapses.

## Recommendation for this project's next phase

The local implementation in `meta-harness/` already covers responsibilities 1, 2, 3, 4, 5 at project scale and 7 partially (audit log + live WS events). Phase 2 work should target, in order:

1. **Upgrade identity (responsibility 2)** — replace TOFU with verifiable-credential based pubkey exchange, so two different projects can talk without prior admin action.
2. **Federated discovery (responsibility 3)** — `/peer` handshake exchanging capability indexes between two `meta-harness` instances. Two harnesses, each running locally, should be able to discover each other's agents.
3. **Metering + settlement (responsibility 6)** — begin tracking per-mission token-equivalent cost via audit log. Actual payments can wait; the measurement can't.
4. **Aggregate observability (responsibility 7)** — publish pseudonymised fleet-health metrics so an external operator can verify the harness is behaving fairly.

## Sources

1. Kenneth Raj Simon, *Global AI Super Harness* — https://kennethraj.net/page.php?slug=global-ai-super-harness
2. Model Context Protocol specification — https://modelcontextprotocol.io
3. W3C Decentralised Identifiers (DIDs) and Verifiable Credentials — foundational for responsibility 2 at scale.
4. Prior-art in federated infrastructure: the Matrix federation protocol (moderation + identity across servers), SSH CA chains (capability attestation), ActivityPub (discovery + federation lessons learned).

## Open questions

- Who underwrites the protocol's governance? A foundation (like the Linux Foundation for Kubernetes)? A multi-stakeholder standards body? An unincorporated consortium?
- How do you prevent the harness itself from becoming the gatekeeper it was built to replace? (The article raises this but does not answer it; it is probably the defining strategic question of the effort.)
- What is the minimum viable federation? Two harnesses from two organisations completing a single cross-boundary mission is the smallest proof-of-concept; getting there is Phase 3 work.
