#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "FAIL: node is unavailable" >&2; exit 1; }
exec node --test "$ROOT/scripts/test-launcher-contract.mjs"
