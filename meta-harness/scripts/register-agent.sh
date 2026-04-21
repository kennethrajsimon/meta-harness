#!/usr/bin/env bash
# Thin wrapper — register-agent.js is the real implementation.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
node scripts/register-agent.js "$@"
