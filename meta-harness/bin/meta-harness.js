#!/usr/bin/env node
// Entrypoint — boots the Meta Harness HTTP+WS service and activates every
// layer registered by Phases 1b..1h. Each phase module exposes a register(app)
// function that attaches routes and subscribes to events; this file is the
// single place they are wired together.

const app = require('../src/server');

// Phase 1g — dashboard projection attaches to app.events (no routes)
try { require('../src/adapters/dashboardProjection').attach(app.events); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Phase 2.1 — capability tokens (trust root auto-generates on first access)
try { require('../src/credentials/trustAnchors').ensureRoot(); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
try { require('../src/credentials/routes').register(app); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Phase 2.2 — observability: counters subscribe to events, gauges live-computed
try { require('../src/observability/metrics').attach(app.events); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
try { require('../src/observability/routes').register(app); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
try { require('../src/observability/checkpoint').start(); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Phase 2.3 — metering: /v1/usage and /v1/missions/:id/usage
try { require('../src/metering/routes').register(app); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Phase 2.4 — federation: peers + handshake + remote capabilities
try { require('../src/federation/routes').register(app); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Phase 2.6 — self-describing discovery URL (public, no auth)
try { require('../src/discovery/routes').register(app); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Phase 1b — registry + identity (credential-aware)
try { require('../src/registry/routes').register(app); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Phase 1d — orchestrator (missions, leases, progress, complete)
try { require('../src/orchestrator/routes').register(app); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

// Phase 1e — safety & governance (halt, cancel)
try { require('../src/safety/routes').register(app); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }

app.start();
