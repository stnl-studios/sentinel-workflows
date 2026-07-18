#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
cd "$ROOT"
export PYTHONDONTWRITEBYTECODE=1

"$PYTHON_BIN" scripts/test-serial-workflow.py

bash scripts/test-validation-runner-contract.sh

bash scripts/test-launcher-contract.sh

node --test skills/stnl-spec-lifecycle-manager/runtime/test/*.test.mjs

node --test scripts/test-lifecycle-contracts.mjs

node --test scripts/test-lifecycle-validator-adversarial.mjs scripts/test-lifecycle-readiness-adversarial.mjs scripts/test-lifecycle-renderer-adversarial.mjs

node --test scripts/test-lifecycle-distribution.mjs

node --test scripts/test-runtime-context-budget.mjs

node --test scripts/test-subagent-packages.mjs
