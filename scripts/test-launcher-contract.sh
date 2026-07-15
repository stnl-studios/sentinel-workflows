#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
START_SECONDS=$SECONDS
FIXTURE="$TMP/prompts"
CHECK_LOG="$TMP/check.log"

copy_fixture() {
  rm -rf "$FIXTURE"
  cp -R "$ROOT/templates/prompts" "$FIXTURE"
}

run_checker() {
  local fixture_root="$1"
  "$PYTHON_BIN" "$ROOT/scripts/check-contracts.py" launchers --root "$fixture_root"
}

expect_rejected() {
  local name="$1"
  local category="$2"
  local fixture_root="$3"
  local status

  if run_checker "$fixture_root" >"$CHECK_LOG" 2>&1; then
    echo "FAIL: invalid launcher mutation accepted: $name" >&2
    cat "$CHECK_LOG" >&2
    exit 1
  else
    status=$?
  fi
  if [[ "$status" -ne 1 ]]; then
    echo "FAIL: launcher mutation hit infrastructure instead of contract rejection: $name (exit $status)" >&2
    cat "$CHECK_LOG" >&2
    exit 1
  fi
  if ! grep -Fq "CONTRACT_ERROR[$category]" "$CHECK_LOG"; then
    echo "FAIL: launcher mutation rejected for the wrong contract category: $name (expected $category)" >&2
    cat "$CHECK_LOG" >&2
    exit 1
  fi
  echo "PASS: rejected $name [$category]"
}

if ! run_checker "$ROOT/templates/prompts"; then
  echo "FAIL: canonical launcher contract is invalid; mutations were not executed" >&2
  exit 1
fi
echo "PASS: accepted 13 canonical launchers"

copy_fixture
mkdir -p "$FIXTURE/fixture-notes" "$FIXTURE/__MACOSX"
printf '%s\n' "Auxiliary fixture note outside the launcher contract." >"$FIXTURE/fixture-notes/README.md"
printf '%s\n' "ignored" >"$FIXTURE/.DS_Store"
printf '%s\n' "ignored" >"$FIXTURE/._packaging"
printf '%s\n' "ignored" >"$FIXTURE/__MACOSX/metadata.md"
if ! run_checker "$FIXTURE"; then
  echo "FAIL: harmless out-of-scope launcher fixture change was rejected" >&2
  exit 1
fi
echo "PASS: accepted 1 out-of-scope launcher control (including ignored macOS metadata)"

mutate() {
  local file="$1"
  local expression="$2"
  "$PYTHON_BIN" - "$FIXTURE" "$FIXTURE/$file" "$expression" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys

root = Path(sys.argv[1])
path = Path(sys.argv[2])
expression = sys.argv[3]

def tree_signature() -> str:
    digest = sha256()
    for item in sorted(root.rglob("*"), key=lambda candidate: candidate.as_posix()):
        relative = item.relative_to(root)
        if "__MACOSX" in relative.parts or item.name == ".DS_Store" or item.name.startswith("._"):
            continue
        if item.is_file():
            digest.update(relative.as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(item.read_bytes())
    return digest.hexdigest()

before = tree_signature()

if expression == "missing-file":
    path.unlink()
elif expression == "legacy-file":
    path.write_text("Use `stnl-slice-executor`.\nOPERATION=FINALIZE_SLICE\n", encoding="utf-8")
else:
    text = path.read_text(encoding="utf-8")

    mutations = {
        "old-skill": ("stnl-execution-planner", "stnl-spec-execution-manager"),
        "wrong-operation": ("OPERATION=PLAN", "OPERATION=FINALIZE_SLICE"),
        "parallel-operation": ("OPERATION=PLAN", "OPERATION=PARALLELIZE_SLICES"),
        "slices-input": ("Contexto adicional (opcional):", "SLICES={{SLICES}}\n\nContexto adicional (opcional):"),
        "execution-root": ("Contexto adicional (opcional):", "EXECUTION_ROOT={{EXECUTION_ROOT}}\n\nContexto adicional (opcional):"),
        "duplicate-spec": ("SPEC_PATH={{SPEC_PATH}}", "SPEC_PATH={{SPEC_PATH}}\nSPEC_PATH={{SPEC_PATH}}"),
        "missing-slice": ("SLICE={{SLICE}}\n", ""),
        "extra-slice": ("Contexto adicional (opcional):", "SLICE={{SLICE}}\n\nContexto adicional (opcional):"),
        "execute-runner": ("Contexto adicional (opcional):", "Faça spawn do runner.\n\nContexto adicional (opcional):"),
        "apply-runner": ("Contexto adicional (opcional):", "Delegue ao runner.\n\nContexto adicional (opcional):"),
        "close-runner": ("Contexto adicional (opcional):", "Use validation runner.\n\nContexto adicional (opcional):"),
        "shared-codex": ("Contexto adicional (opcional):", "Codex stnl_validation_runner\n\nContexto adicional (opcional):"),
        "shared-claude": ("Contexto adicional (opcional):", "Claude @agent-stnl-validation-runner\n\nContexto adicional (opcional):"),
        "codex-claude-id": ("`stnl_validation_runner`", "`stnl_validation_runner` e @agent-stnl-validation-runner"),
        "claude-codex-id": ("@agent-stnl-validation-runner", "stnl_validation_runner"),
        "codex-no-spawn": ("Faça spawn", "Use"),
        "claude-optional": ("Delegue obrigatoriamente", "Delegue opcionalmente"),
        "fallback": ("Não faça fallback", "Faça fallback"),
        "redo-validation": ("não refaz a validação", "refaz a validação"),
        "no-auto-finish": ("substitui a Effective Validation Base e finaliza a slice", "apenas reporta `PASS`"),
        "extra-text": ("Contexto adicional (opcional):", "Linha não canônica.\nContexto adicional (opcional):"),
    }
    if expression not in mutations:
        raise SystemExit(f"unknown mutation: {expression}")
    old, new = mutations[expression]
    if old not in text:
        raise SystemExit(f"missing mutation source: {old!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")

if before == tree_signature():
    raise SystemExit(f"mutation was not applied: {expression}")
PY
}

case_mutation() {
  local name="$1"
  local category="$2"
  local file="$3"
  local expression="$4"

  copy_fixture
  mutate "$file" "$expression"
  expect_rejected "$name" "$category" "$FIXTURE"
}

case_mutation old-skill L002_SKILL execution-plan.md old-skill
case_mutation old-operation L003_OPERATION execution-plan.md wrong-operation
case_mutation parallel-operation L003_OPERATION execution-plan.md parallel-operation
case_mutation slices-input L005_REMOVED_CONTRACT execution-plan.md slices-input
case_mutation explicit-execution-root L004_INPUTS execution-plan.md execution-root
case_mutation duplicate-spec-path L004_INPUTS execution-plan.md duplicate-spec
case_mutation missing-slice L004_INPUTS slice-execute.md missing-slice
case_mutation slice-on-close L004_INPUTS execution-close.md extra-slice
case_mutation execute-invokes-runner L006_SHARED_ISOLATION slice-execute.md execute-runner
case_mutation apply-findings-invokes-runner L006_SHARED_ISOLATION slice-apply-findings.md apply-runner
case_mutation close-invokes-runner L006_SHARED_ISOLATION execution-close.md close-runner
case_mutation shared-codex-identifier L006_SHARED_ISOLATION slice-execute.md shared-codex
case_mutation shared-claude-identifier L006_SHARED_ISOLATION execution-close.md shared-claude
case_mutation codex-contains-claude L007_PLATFORM_IDENTITY slice-validate-codex.md codex-claude-id
case_mutation claude-contains-codex L007_PLATFORM_IDENTITY slice-validate-claude.md claude-codex-id
case_mutation codex-missing-spawn L007_PLATFORM_IDENTITY slice-validate-codex.md codex-no-spawn
case_mutation claude-optional-delegation L007_PLATFORM_IDENTITY slice-validate-claude.md claude-optional
case_mutation validation-fallback L008_VALIDATION_FLOW slice-validate-codex.md fallback
case_mutation main-context-redoes-validation L008_VALIDATION_FLOW slice-validate-claude.md redo-validation
case_mutation pass-does-not-finalize L008_VALIDATION_FLOW slice-validate-codex.md no-auto-finish
case_mutation extra-launcher-text L009_CONTEXT_FORMAT execution-tasks-review.md extra-text
case_mutation missing-launcher L001_REGISTRY execution-close.md missing-file
case_mutation legacy-launcher L001_REGISTRY slice-finalize.md legacy-file

echo "PASS: 23 invalid launcher mutations rejected by the semantic checker against isolated fixtures"
echo "PASS: focused launcher contract suite completed in $((SECONDS - START_SECONDS))s"
