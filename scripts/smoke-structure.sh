#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
command -v node >/dev/null 2>&1 || { echo "FAIL: node is unavailable" >&2; exit 1; }

node --test scripts/test-execution-contract.mjs
node --test scripts/test-skill-consolidation.mjs
node --test skills/workflows/stnl-spec-test-runbook/runtime/test/*.test.mjs
node --test scripts/test-runbook-execution-compat.mjs
node --test scripts/test-execution-layout.mjs
node --test scripts/test-launcher-contract.mjs
node --test scripts/test-validation-runner-contract.mjs
node --test scripts/test-repository-contract.mjs
node --test skills/workflows/stnl-spec-lifecycle-manager/runtime/test/*.test.mjs
node --test scripts/test-lifecycle-contracts.mjs
node --test scripts/test-lifecycle-validator-adversarial.mjs scripts/test-lifecycle-readiness-adversarial.mjs scripts/test-lifecycle-renderer-adversarial.mjs
node --test scripts/test-lifecycle-distribution.mjs
node --test scripts/test-runtime-context-budget.mjs
node --test scripts/test-subagent-packages.mjs
