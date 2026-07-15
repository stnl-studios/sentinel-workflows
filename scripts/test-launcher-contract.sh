#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
START_SECONDS=$SECONDS
FIXTURE="$TMP/prompts"
EXECUTOR_FIXTURE="$TMP/executor/SKILL.md"
CHECK_LOG="$TMP/check.log"

copy_fixture() {
  rm -rf "$FIXTURE"
  cp -R "$ROOT/templates/prompts" "$FIXTURE"
  mkdir -p "$(dirname "$EXECUTOR_FIXTURE")"
  cp "$ROOT/skills/stnl-slice-executor/SKILL.md" "$EXECUTOR_FIXTURE"
}

run_checker() {
  local fixture_root="$1"
  local executor_path="${2:-$ROOT/skills/stnl-slice-executor/SKILL.md}"
  "$PYTHON_BIN" "$ROOT/scripts/check-contracts.py" launchers --root "$fixture_root" --executor "$executor_path"
}

expect_rejected() {
  local name="$1"
  local category="$2"
  local fixture_root="$3"
  local status

  if run_checker "$fixture_root" "$EXECUTOR_FIXTURE" >"$CHECK_LOG" 2>&1; then
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
echo "PASS: accepted 15 canonical launchers"

copy_fixture
mkdir -p "$FIXTURE/fixture-notes" "$FIXTURE/__MACOSX"
printf '%s\n' "Auxiliary fixture note outside the launcher contract." >"$FIXTURE/fixture-notes/README.md"
printf '%s\n' "ignored" >"$FIXTURE/.DS_Store"
printf '%s\n' "ignored" >"$FIXTURE/._packaging"
printf '%s\n' "ignored" >"$FIXTURE/__MACOSX/metadata.md"
if ! run_checker "$FIXTURE" "$EXECUTOR_FIXTURE"; then
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
elif expression == "shared-execute":
    path.write_text("Use `stnl-slice-executor`.\nOPERATION=EXECUTE_SLICE\n", encoding="utf-8")
elif expression == "shared-findings":
    path.write_text("Use `stnl-slice-executor`.\nOPERATION=APPLY_FINDINGS\n", encoding="utf-8")
elif expression == "manual-tests":
    path.write_text("Use `stnl-slice-executor`.\nOPERATION=RUN_TESTS\n", encoding="utf-8")
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
        "close-runner": ("Contexto adicional (opcional):", "Use validation runner.\n\nContexto adicional (opcional):"),
        "shared-codex": ("Contexto adicional (opcional):", "Codex stnl_validation_runner\n\nContexto adicional (opcional):"),
        "shared-claude": ("Contexto adicional (opcional):", "Claude @agent-stnl-validation-runner\n\nContexto adicional (opcional):"),
        "codex-claude-id": ("`stnl_validation_runner`", "`stnl_validation_runner` e @agent-stnl-validation-runner"),
        "claude-codex-id": ("@agent-stnl-validation-runner", "stnl_validation_runner"),
        "codex-no-spawn-upper": ("Faça spawn", "Use"),
        "codex-no-spawn-lower": ("faça spawn", "use"),
        "claude-optional-upper": ("Delegue obrigatoriamente", "Execute diretamente"),
        "claude-optional-lower": ("delegue obrigatoriamente", "execute diretamente"),
        "fallback": ("Não faça fallback", "Faça fallback"),
        "redo-validation": ("não refaz a validação", "refaz a validação"),
        "no-auto-finish": ("substitui a Effective Validation Base e finaliza a slice", "apenas reporta `PASS`"),
        "formal-pass": ("Contexto adicional (opcional):", "Emita `PASS` formal.\n\nContexto adicional (opcional):"),
        "create-attempt": ("Contexto adicional (opcional):", "Crie Validation Attempt para o check.\n\nContexto adicional (opcional):"),
        "complete-slice": ("Contexto adicional (opcional):", "Marque a conclusão `[x]`.\n\nContexto adicional (opcional):"),
        "main-runs-tests": ("Não execute no contexto principal testes", "Execute no contexto principal testes"),
        "one-runner-call": ("no mínimo uma vez e no máximo três vezes", "exatamente uma vez"),
        "zero-runner-calls": ("no mínimo uma vez e no máximo três vezes", "zero a três vezes"),
        "up-to-three-only": ("no mínimo uma vez e no máximo três vezes", "up to three times"),
        "optional-runner-call": ("Invoque o runner no mínimo uma vez", "Pode invocar o runner"),
        "skip-runner-no-tests": ("Não pule o runner por mudança simples nem por acreditar que nenhum check seja aplicável", "Pule o runner quando acreditar que nenhum check seja aplicável"),
        "unbounded-rechecks": ("nem use loop ilimitado", "e use loop ilimitado"),
        "fourth-recheck": ("nunca faça uma quarta chamada", "faça uma quarta chamada"),
        "stop-on-first-fail": ("Em `TESTS_FAIL` nas rodadas 1 ou 2", "Em todo `TESTS_FAIL`, encerre imediatamente"),
        "manual-retry": ("não crie etapa manual de retry", "crie etapa manual de retry"),
        "auto-validate": ("não inicie `VALIDATE_SLICE`", "inicie `VALIDATE_SLICE`"),
        "not-applicable-as-pass": ("não o trate como `PASS` formal", "trate-o como `PASS` formal"),
        "not-applicable-no-rationale": ("`TESTS_NOT_APPLICABLE` exige descoberta objetiva, fontes e ações read-only resumidas, justificativa e nenhum comando de verificação executado", "`TESTS_NOT_APPLICABLE` não exige descoberta ou justificativa"),
        "quality-skips-not-applicable-review": ("Exija revisão independente da descoberta e justificativa", "Aceite sem revisão independente da descoberta e justificativa"),
        "claude-four-round-limit": ("no mínimo uma vez e no máximo três vezes", "no mínimo uma vez e no máximo quatro vezes"),
        "close-retry": ("Contexto adicional (opcional):", "Faça retry dos checks.\n\nContexto adicional (opcional):"),
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

mutate_executor() {
  local expression="$1"
  "$PYTHON_BIN" - "$EXECUTOR_FIXTURE" "$expression" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
expression = sys.argv[2]
text = path.read_text(encoding="utf-8")
mutations = {
    "executor-zero-calls": ("at least once and at most three times", "zero to three calls"),
    "executor-up-to-only": ("at least once and at most three times", "up to three times"),
    "executor-optional-invocation": ("The first invocation is mandatory after the initial implementation or correction", "Runner invocation is optional after the initial implementation or correction"),
    "executor-skip-not-applicable": ("cannot be skipped because the change appears simple or because no check is expected to apply", "skip the runner when no tests apply"),
}
if expression not in mutations:
    raise SystemExit(f"unknown executor mutation: {expression}")
old, new = mutations[expression]
if old not in text:
    raise SystemExit(f"missing executor mutation source: {old!r}")
mutated = text.replace(old, new, 1)
if mutated == text:
    raise SystemExit(f"executor mutation was not applied: {expression}")
path.write_text(mutated, encoding="utf-8")
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

case_executor_mutation() {
  local name="$1"
  local expression="$2"

  copy_fixture
  mutate_executor "$expression"
  expect_rejected "$name" L014_AUTOMATIC_RECHECK "$FIXTURE"
}

case_mutation old-skill L002_SKILL execution-plan.md old-skill
case_mutation old-operation L003_OPERATION execution-plan.md wrong-operation
case_mutation parallel-operation L003_OPERATION execution-plan.md parallel-operation
case_mutation slices-input L005_REMOVED_CONTRACT execution-plan.md slices-input
case_mutation explicit-execution-root L004_INPUTS execution-plan.md execution-root
case_mutation duplicate-spec-path L004_INPUTS execution-plan.md duplicate-spec
case_mutation missing-slice L004_INPUTS slice-execute-codex.md missing-slice
case_mutation slice-on-close L004_INPUTS execution-close.md extra-slice
case_mutation close-invokes-runner L006_SHARED_ISOLATION execution-close.md close-runner
case_mutation shared-codex-identifier L006_SHARED_ISOLATION execution-plan.md shared-codex
case_mutation shared-claude-identifier L006_SHARED_ISOLATION execution-close.md shared-claude
case_mutation codex-contains-claude L007_PLATFORM_IDENTITY slice-validate-codex.md codex-claude-id
case_mutation claude-contains-codex L007_PLATFORM_IDENTITY slice-validate-claude.md claude-codex-id
case_mutation codex-missing-spawn L007_PLATFORM_IDENTITY slice-validate-codex.md codex-no-spawn-upper
case_mutation claude-optional-delegation L007_PLATFORM_IDENTITY slice-validate-claude.md claude-optional-upper
case_mutation execute-codex-missing-spawn L007_PLATFORM_IDENTITY slice-execute-codex.md codex-no-spawn-lower
case_mutation execute-claude-missing-delegation L007_PLATFORM_IDENTITY slice-execute-claude.md claude-optional-lower
case_mutation findings-codex-missing-spawn L007_PLATFORM_IDENTITY slice-apply-findings-codex.md codex-no-spawn-lower
case_mutation findings-claude-missing-delegation L007_PLATFORM_IDENTITY slice-apply-findings-claude.md claude-optional-lower
case_mutation execute-formal-pass L013_CHECK_AUTHORITY slice-execute-codex.md formal-pass
case_mutation findings-creates-attempt L013_CHECK_AUTHORITY slice-apply-findings-claude.md create-attempt
case_mutation execute-completes-slice L013_CHECK_AUTHORITY slice-execute-claude.md complete-slice
case_mutation main-context-runs-tests L012_CHECK_DELEGATION slice-execute-codex.md main-runs-tests
case_mutation executor-calls-runner-once L014_AUTOMATIC_RECHECK slice-execute-codex.md one-runner-call
case_mutation executor-allows-zero-runner-calls L014_AUTOMATIC_RECHECK slice-execute-codex.md zero-runner-calls
case_mutation executor-says-only-up-to-three-times L014_AUTOMATIC_RECHECK slice-execute-claude.md up-to-three-only
case_mutation launcher-makes-runner-optional L014_AUTOMATIC_RECHECK slice-apply-findings-codex.md optional-runner-call
case_mutation launcher-skips-runner-without-tests L014_AUTOMATIC_RECHECK slice-execute-codex.md skip-runner-no-tests
case_mutation executor-allows-unbounded-rechecks L014_AUTOMATIC_RECHECK slice-execute-claude.md unbounded-rechecks
case_mutation executor-allows-fourth-round L014_AUTOMATIC_RECHECK slice-apply-findings-codex.md fourth-recheck
case_mutation executor-stops-on-first-failure L014_AUTOMATIC_RECHECK slice-apply-findings-claude.md stop-on-first-fail
case_mutation executor-creates-manual-retry L014_AUTOMATIC_RECHECK slice-execute-codex.md manual-retry
case_mutation executor-auto-validates L014_AUTOMATIC_RECHECK slice-execute-claude.md auto-validate
case_mutation non-applicability-promoted-to-pass L013_CHECK_AUTHORITY slice-execute-codex.md not-applicable-as-pass
case_mutation non-applicability-without-rationale L012_CHECK_DELEGATION slice-apply-findings-claude.md not-applicable-no-rationale
case_mutation quality-skips-non-applicability-review L008_VALIDATION_FLOW slice-validate-codex.md quality-skips-not-applicable-review
case_mutation codex-claude-round-limit-diverges L014_AUTOMATIC_RECHECK slice-execute-claude.md claude-four-round-limit
case_mutation validation-fallback L008_VALIDATION_FLOW slice-validate-codex.md fallback
case_mutation main-context-redoes-validation L008_VALIDATION_FLOW slice-validate-claude.md redo-validation
case_mutation pass-does-not-finalize L008_VALIDATION_FLOW slice-validate-codex.md no-auto-finish
case_mutation extra-launcher-text L009_CONTEXT_FORMAT execution-tasks-review.md extra-text
case_mutation missing-launcher L001_REGISTRY execution-close.md missing-file
case_mutation legacy-launcher L001_REGISTRY slice-finalize.md legacy-file
case_mutation shared-execute-launcher L001_REGISTRY slice-execute.md shared-execute
case_mutation shared-findings-launcher L001_REGISTRY slice-apply-findings.md shared-findings
case_mutation manual-test-operation L001_REGISTRY run-tests.md manual-tests
case_mutation close-retries-checks L006_SHARED_ISOLATION execution-close.md close-retry
case_executor_mutation executor-contract-allows-zero-calls executor-zero-calls
case_executor_mutation executor-contract-says-up-to-only executor-up-to-only
case_executor_mutation executor-contract-makes-invocation-optional executor-optional-invocation
case_executor_mutation executor-contract-skips-not-applicable executor-skip-not-applicable

echo "PASS: 51 invalid executor/launcher mutations rejected by the semantic checker against isolated fixtures"
echo "PASS: focused launcher contract suite completed in $((SECONDS - START_SECONDS))s"
