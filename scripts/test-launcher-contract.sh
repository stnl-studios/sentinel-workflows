#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$ROOT/templates/prompts" "$TMP/prompts"

run_validator() {
  PROMPT_ROOT="$TMP/prompts" bash "$ROOT/scripts/validate-targets.sh" >/dev/null
}

expect_rejected() {
  local name="$1"
  if run_validator; then
    echo "FAIL: invalid launcher mutation accepted: $name" >&2
    exit 1
  fi
  echo "PASS: rejected $name"
}

run_validator
echo "PASS: accepted 13 canonical launchers"

mutate() {
  local file="$1"
  local expression="$2"
  python3 - "$TMP/prompts/$file" "$expression" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
expression = sys.argv[2]
text = path.read_text(encoding="utf-8")
if expression == "duplicate-spec-path":
    text = text.replace("SPEC_PATH={{SPEC_PATH}}\n", "SPEC_PATH={{SPEC_PATH}}\nSPEC_PATH={{SPEC_PATH}}\n", 1)
elif expression == "duplicate-slice":
    text = text.replace("SLICE={{SLICE}}\n", "SLICE={{SLICE}}\nSLICE={{SLICE}}\n", 1)
elif expression == "move-required":
    text = text.replace("SPEC_PATH={{SPEC_PATH}}\nSLICE={{SLICE}}", "SLICE={{SLICE}}\nSPEC_PATH={{SPEC_PATH}}", 1)
elif expression == "before-context":
    text = text.replace("\nContexto adicional (opcional):", "\nLinha arbitrária.\nContexto adicional (opcional):", 1)
elif expression == "after-context":
    text += "Texto adicional.\n"
elif expression == "remove-context":
    text = text.replace("\nContexto adicional (opcional):", "", 1)
elif expression == "duplicate-context":
    text += "Contexto adicional (opcional):\n"
elif expression == "extra-instruction":
    text = text.replace("\nContexto adicional (opcional):", "\nFaça qualquer refactor necessário.\nContexto adicional (opcional):", 1)
elif expression == "unknown-placeholder":
    text = text.replace("SPEC_PATH={{SPEC_PATH}}", "SPEC_PATH={{UNKNOWN}}", 1)
elif expression == "angle-placeholder":
    text = text.replace("{{SPEC_PATH}}", "<SPEC_PATH>", 1)
elif expression == "execution-root":
    text = text.replace("\nContexto adicional (opcional):", "\nEXECUTION_ROOT={{EXECUTION_ROOT}}\nContexto adicional (opcional):", 1)
elif expression == "mode-in-execution":
    text = text.replace("OPERATION=PLAN", "MODE=INIT\nOPERATION=PLAN", 1)
elif expression == "operation-in-lifecycle":
    text = text.replace("MODE=CLOSE", "MODE=CLOSE\nOPERATION=CLOSE", 1)
elif expression == "slice-without-slice":
    text = text.replace("\nContexto adicional (opcional):", "\nSLICE={{SLICE}}\nContexto adicional (opcional):", 1)
elif expression == "slices-outside-parallel":
    text = text.replace("\nContexto adicional (opcional):", "\nSLICES={{SLICES}}\nContexto adicional (opcional):", 1)
else:
    raise SystemExit(f"unknown mutation: {expression}")
path.write_text(text, encoding="utf-8")
PY
}

case_mutation() {
  local name="$1"
  local file="$2"
  local expression="$3"
  rm -rf "$TMP/prompts"
  cp -R "$ROOT/templates/prompts" "$TMP/prompts"
  mutate "$file" "$expression"
  expect_rejected "$name"
}

case_mutation duplicate-spec-path spec-planning.md duplicate-spec-path
case_mutation duplicate-slice slice-execute.md duplicate-slice
case_mutation required-placeholder-wrong-position slice-execute.md move-required
case_mutation arbitrary-line-before-context execution-plan.md before-context
case_mutation arbitrary-line-after-context execution-plan.md after-context
case_mutation missing-context-title execution-plan.md remove-context
case_mutation repeated-context-title execution-plan.md duplicate-context
case_mutation extra-operational-instruction execution-plan.md extra-instruction
case_mutation unknown-placeholder execution-plan.md unknown-placeholder
case_mutation angle-placeholder execution-plan.md angle-placeholder
case_mutation execution-root-placeholder execution-plan.md execution-root
case_mutation mode-in-execution execution-plan.md mode-in-execution
case_mutation operation-in-lifecycle spec-close.md operation-in-lifecycle
case_mutation slice-in-non-slice-operation execution-plan.md slice-without-slice
case_mutation slices-outside-parallel execution-plan.md slices-outside-parallel

echo "PASS: 15 invalid launcher mutations rejected"
