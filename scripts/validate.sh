#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_SMOKE=0

usage() {
  echo "usage: scripts/validate.sh [--no-smoke]" >&2
}

case "$#" in
  0) ;;
  1)
    if [[ "$1" == "--no-smoke" ]]; then
      SKIP_SMOKE=1
    else
      usage
      exit 2
    fi
    ;;
  *)
    usage
    exit 2
    ;;
esac

cd "$ROOT"
command -v node >/dev/null 2>&1 || { echo "FAIL: node is unavailable" >&2; exit 1; }

while IFS= read -r -d '' module; do
  node --check "$module"
done < <(find scripts skills templates benchmarks -type f -name '*.mjs' -print0)

node --test benchmarks/sentinel-todo/seed/test/*.test.mjs
node scripts/test-benchmark-contract.mjs
node --test scripts/test-benchmark-production-pilot.mjs

node scripts/check-contracts.mjs repository --root "$ROOT"
node scripts/check-contracts.mjs launchers --root templates/prompts
node scripts/check-contracts.mjs subagents --root agents

execution_skills=(
  skills/workflows/stnl-execution-planner
  skills/workflows/stnl-plan-reviewer
  skills/workflows/stnl-task-materializer
  skills/workflows/stnl-task-reviewer
  skills/workflows/stnl-slice-executor
  skills/workflows/stnl-slice-quality-manager
)
node scripts/check-distributable-skills.mjs \
  "${execution_skills[@]}" \
  skills/workflows/stnl-spec-lifecycle-manager \
  skills/workflows/stnl-spec-roadmap \
  skills/workflows/stnl-spec-test-runbook

if [[ "$SKIP_SMOKE" == "0" ]]; then
  bash scripts/smoke-structure.sh
fi

echo "PASS: repository validation checks"
