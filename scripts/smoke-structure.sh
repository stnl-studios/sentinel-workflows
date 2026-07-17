#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
cd "$ROOT"
export PYTHONDONTWRITEBYTECODE=1

"$PYTHON_BIN" scripts/test-serial-workflow.py

"$PYTHON_BIN" scripts/test-spec-lifecycle.py

"$PYTHON_BIN" scripts/test-build-closed-spec.py

"$PYTHON_BIN" scripts/test-readiness-attestation.py

"$PYTHON_BIN" scripts/test-publisher-recovery.py

"$PYTHON_BIN" scripts/test-runtime-context-budget.py
