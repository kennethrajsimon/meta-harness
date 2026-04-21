#!/usr/bin/env bash
# Run every smoke test in sequence against a live meta-harness + broker.
# Assumes you've already started both (scripts/start-all.sh).

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "${META_HARNESS_ADMIN_TOKEN:-}" ]; then
  echo "META_HARNESS_ADMIN_TOKEN must be set" >&2
  exit 1
fi

echo
echo "=== smoke-register (Phase 1b: identity + TOFU + nonce) ==="
node test/smoke-register.js

echo
echo "=== smoke-mission (Phase 1a-1e: full orchestration path) ==="
node test/smoke-mission.js

echo
echo "=== smoke-broker (Phase 1f: fleet-log bridge) ==="
node test/smoke-broker.js

echo
echo "=== smoke-mcp (Phase 1h: MCP stdio server) ==="
node test/smoke-mcp.js

echo
echo "=== smoke-credentials (Phase 2.1: capability tokens) ==="
node test/smoke-credentials.js

echo
echo "=== smoke-metrics (Phase 2.2: observability) ==="
node test/smoke-metrics.js

echo
echo "=== smoke-metering (Phase 2.3: metering + usage) ==="
node test/smoke-metering.js

echo
echo "=== smoke-federation (Phase 2.4: federated discovery) ==="
node test/smoke-federation.js

echo
echo "ALL SMOKE TESTS PASSED"
