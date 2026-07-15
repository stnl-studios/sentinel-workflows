#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
START_SECONDS=$SECONDS
FIXTURE="$TMP/subagents"
CHECK_LOG="$TMP/check.log"

copy_fixture() {
  rm -rf "$FIXTURE"
  cp -R "$ROOT/templates/subagents" "$FIXTURE"
}

run_checker() {
  local fixture_root="$1"
  "$PYTHON_BIN" "$ROOT/scripts/check-contracts.py" validation-runner --root "$fixture_root"
}

expect_rejected() {
  local name="$1"
  local category="$2"
  local fixture_root="$3"
  local status

  if run_checker "$fixture_root" >"$CHECK_LOG" 2>&1; then
    echo "FAIL: invalid validation-runner mutation accepted: $name" >&2
    cat "$CHECK_LOG" >&2
    exit 1
  else
    status=$?
  fi
  if [[ "$status" -ne 1 ]]; then
    echo "FAIL: validation-runner mutation hit infrastructure instead of contract rejection: $name (exit $status)" >&2
    cat "$CHECK_LOG" >&2
    exit 1
  fi
  if ! grep -Fq "CONTRACT_ERROR[$category]" "$CHECK_LOG"; then
    echo "FAIL: validation-runner mutation rejected for the wrong contract category: $name (expected $category)" >&2
    cat "$CHECK_LOG" >&2
    exit 1
  fi
  echo "PASS: rejected $name [$category]"
}

if ! run_checker "$ROOT/templates/subagents"; then
  echo "FAIL: canonical validation-runner contract is invalid; mutations were not executed" >&2
  exit 1
fi
echo "PASS: accepted canonical validation-runner templates"

copy_fixture
mkdir -p "$FIXTURE/fixture-notes" "$FIXTURE/codex/.codex/agents/__MACOSX"
printf '%s\n' "Auxiliary fixture note outside the validation-runner contract." >"$FIXTURE/fixture-notes/README.md"
printf '%s\n' "ignored" >"$FIXTURE/codex/.codex/agents/.DS_Store"
printf '%s\n' "ignored" >"$FIXTURE/codex/.codex/agents/._packaging"
printf '%s\n' "ignored" >"$FIXTURE/codex/.codex/agents/__MACOSX/metadata.toml"
if ! run_checker "$FIXTURE"; then
  echo "FAIL: harmless out-of-scope validation-runner fixture change was rejected" >&2
  exit 1
fi
echo "PASS: accepted 1 out-of-scope validation-runner control (including ignored macOS metadata)"

mutate() {
  local expression="$1"
  "$PYTHON_BIN" - "$FIXTURE" "$expression" <<'PY'
from hashlib import sha256
from pathlib import Path
import sys

root = Path(sys.argv[1])
expression = sys.argv[2]
codex = root / "codex/.codex/agents/stnl_validation_runner.toml"
claude = root / "claude-code/.claude/agents/stnl-validation-runner.md"
readme = root / "README.md"

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

def replace(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"missing mutation source in {path}: {old!r}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")

def replace_adapters(old: str, new: str) -> None:
    replace(codex, old, new)
    replace(claude, old, new)

if expression == "codex-model":
    replace(codex, 'model = "gpt-5.4-mini"', 'model = "gpt-5.4"')
elif expression == "codex-effort":
    replace(codex, 'model_reasoning_effort = "medium"', 'model_reasoning_effort = "high"')
elif expression == "codex-name":
    replace(codex, 'name = "stnl_validation_runner"', 'name = "other_runner"')
elif expression == "codex-depth":
    replace(codex, "max_depth = 1", "max_depth = 2")
elif expression == "claude-model":
    replace(claude, "model: haiku", "model: sonnet")
elif expression == "claude-effort":
    replace(claude, "effort: medium", "effort: high")
elif expression == "claude-name":
    replace(claude, "name: stnl-validation-runner", "name: other-runner")
elif expression == "claude-write":
    replace(claude, "tools: Read, Glob, Grep, Bash", "tools: Read, Glob, Grep, Bash, Write")
elif expression == "missing-adapter":
    claude.unlink()
elif expression == "renamed-adapter":
    codex.rename(codex.with_name("stnl-validation-runner.toml"))
elif expression == "divergence":
    replace(claude, "Não invente comandos", "Você pode inventar comandos")
elif expression == "missing-execute-operation":
    replace_adapters("OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=APPLY_FINDINGS|VALIDATE_SLICE")
elif expression == "missing-apply-operation":
    replace_adapters("OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|VALIDATE_SLICE")
elif expression == "close-operation":
    replace_adapters("OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|CLOSE")
elif expression == "run-tests-operation":
    replace_adapters("OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|RUN_TESTS")
elif expression == "finalize-operation":
    replace_adapters("OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|FINALIZE_SLICE")
elif expression == "parallel-operation":
    replace_adapters("OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|PARALLELIZE_SLICES")
elif expression == "formal-pass-in-check":
    replace_adapters("# EXECUTE_SLICE", "# EXECUTE_SLICE\n\nEmita `PASS` formal para checks aprovados.")
elif expression == "effective-base-in-check":
    replace_adapters("# EXECUTE_SLICE", "# EXECUTE_SLICE\n\nCrie Effective Validation Base em `TESTS_PASS`.")
elif expression == "attempt-in-findings-check":
    replace_adapters("# APPLY_FINDINGS", "# APPLY_FINDINGS\n\nCrie Validation Attempt para cada check.")
elif expression == "complete-in-check":
    replace_adapters("# EXECUTE_SLICE", "# EXECUTE_SLICE\n\nMarque a conclusão `[x]`.")
elif expression == "check-status-pass":
    replace_adapters("Status: TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED", "Status: PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED")
elif expression == "missing-not-applicable-status":
    replace_adapters("STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|TESTS_NOT_APPLICABLE|BLOCKED", "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|BLOCKED")
elif expression == "unprefixed-not-applicable":
    replace_adapters("STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|TESTS_NOT_APPLICABLE|BLOCKED", "STATUS_CHECKS=TESTS_PASS|TESTS_FAIL|NOT_APPLICABLE|BLOCKED")
elif expression == "tool-missing-is-not-applicable":
    replace_adapters("check aplicável que não pode ser executado por ferramenta, credencial, dependência externa, ambiente, serviço, permissão ou comando autoritativo objetivamente indisponível é `BLOCKED`", "check aplicável que não pode ser executado por ferramenta ausente é `TESTS_NOT_APPLICABLE`")
elif expression == "command-failure-is-not-applicable":
    replace_adapters("Falha de verification command é `TESTS_FAIL`", "Falha de verification command é `TESTS_NOT_APPLICABLE`")
elif expression == "missing-discovery":
    replace_adapters("Descubra checks autoritativos antes de escolher um status.", "Escolha um status sem descoberta objetiva.")
elif expression == "discovery-prohibited":
    replace_adapters("Discovery actions são ações read-only usadas somente para determinar quais checks existem, quais comandos são autoritativos e se algum check se aplica ao escopo.", "Nenhuma ação de descoberta é permitida.")
elif expression == "reads-are-verification":
    replace_adapters("são permitidos; não contam como verification commands", "são permitidos; contam como verification commands")
elif expression == "not-applicable-without-runner":
    replace_adapters("Nunca retorne `TESTS_NOT_APPLICABLE` sem a invocação e a descoberta do runner, nem quando algum verification command tiver sido executado.", "Pode retornar `TESTS_NOT_APPLICABLE` sem invocar o runner.")
elif expression == "not-applicable-with-commands":
    replace_adapters("`Comandos executados` e `Resultado de cada comando e exit code` devem declarar que nenhum verification command foi executado", "`Comandos executados` pode listar verification command executado em `TESTS_NOT_APPLICABLE`")
elif expression == "ambiguous-confirmation-schema":
    replace_adapters("No verification-command confirmation:\n", "No-command confirmation:\n")
elif expression == "not-applicable-no-discovery-schema":
    replace_adapters("Check discovery sources:\n", "")
elif expression == "not-applicable-no-rationale-schema":
    replace_adapters("Non-applicability rationale:\n", "")
elif expression == "not-applicable-promoted-to-pass":
    replace_adapters("rejeite a não aplicabilidade quando descobrir verification command aplicável omitido", "promova a não aplicabilidade a `PASS` quando nenhum check foi executado")
elif expression == "missing-automatic-round-schema":
    replace_adapters("Automatic check round:\n", "")
elif expression == "fourth-round-input":
    replace(claude, "`1/3`, `2/3` ou `3/3`", "`1/4`, `2/4`, `3/4` ou `4/4`")
elif expression == "allows-correction":
    replace_adapters("Não aplique correções", "Aplique correções")
elif expression == "divergent-operations":
    replace(claude, "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|VALIDATE_SLICE")
elif expression == "missing-status":
    replace_adapters("PASS | NEEDS_FIX | BLOCKED", "PASS | BLOCKED")
elif expression == "missing-type":
    replace_adapters("Tipo de validação: initial | revalidation\n", "")
elif expression == "missing-head":
    replace_adapters("HEAD:\n", "")
elif expression == "missing-hashes":
    replace_adapters("Manifesto final da slice:\n", "")
elif expression == "invalid-hash-rule":
    replace_adapters("SHA-256 minúsculo", "hash arbitrário")
elif expression == "missing-removed-marker":
    replace_adapters("com SHA-256 minúsculo do conteúdo ou `REMOVED` quando ausente.", "com SHA-256 minúsculo do conteúdo quando presente.")
elif expression == "allows-edit":
    replace_adapters("Não edite código, testes, requisitos, planos ou tasks.", "Edite código quando necessário.")
elif expression == "missing-overlap":
    replace_adapters("Overlap com bases anteriores:\n", "")
elif expression == "missing-regressions":
    replace_adapters("Regressões justificadas executadas:\n", "")
elif expression == "nonpass-effective-base":
    replace_adapters("não proponha Effective Validation Base", "proponha Effective Validation Base")
elif expression == "readme-manual-tests":
    replace(readme, "Não existe passo manual adicional de testes.", "Existe passo manual adicional de testes.")
elif expression == "readme-fallback":
    replace(readme, "Não existe fallback", "Existe fallback")
elif expression == "readme-missing-codex":
    replace(readme, "slice-validate-codex.md", "validation.md")
elif expression == "readme-missing-claude":
    replace(readme, "slice-validate-claude.md", "validation.md")
elif expression == "readme-attempt-for-checks":
    replace(readme, "Somente `VALIDATE_SLICE` cria uma Validation Attempt.", "Toda operação cria uma Validation Attempt.")
elif expression == "readme-close-runner":
    replace(readme, "`CLOSE` permanece read-only e não usa o runner, não executa testes, não faz retry nem aplica correções.", "`CLOSE` usa o runner, executa testes e faz retry.")
elif expression == "readme-manual-retry":
    replace(readme, "operação manual de retry", "operação manual `RETRY_TESTS`")
elif expression == "readme-prohibits-discovery":
    replace(readme, "Discovery actions são leituras e comandos read-only", "Nenhum comando ou ação pode ser usado na descoberta; discovery actions são proibidas")
else:
    raise SystemExit(f"unknown mutation: {expression}")

if before == tree_signature():
    raise SystemExit(f"mutation was not applied: {expression}")
PY
}

case_mutation() {
  local name="$1"
  local category="$2"
  local expression="$3"

  copy_fixture
  mutate "$expression"
  expect_rejected "$name" "$category" "$FIXTURE"
}

case_mutation codex-wrong-model R001_ADAPTER_METADATA codex-model
case_mutation codex-wrong-effort R001_ADAPTER_METADATA codex-effort
case_mutation codex-wrong-name R001_ADAPTER_METADATA codex-name
case_mutation codex-nested-agent R001_ADAPTER_METADATA codex-depth
case_mutation claude-wrong-model R001_ADAPTER_METADATA claude-model
case_mutation claude-wrong-effort R001_ADAPTER_METADATA claude-effort
case_mutation claude-wrong-name R001_ADAPTER_METADATA claude-name
case_mutation claude-write-tool R001_ADAPTER_METADATA claude-write
case_mutation missing-adapter R002_REGISTRY missing-adapter
case_mutation renamed-adapter R002_REGISTRY renamed-adapter
case_mutation platform-contract-divergence R003_EQUIVALENCE divergence
case_mutation runner-missing-execute-operation R004_OPERATION_SCOPE missing-execute-operation
case_mutation runner-missing-apply-findings-operation R004_OPERATION_SCOPE missing-apply-operation
case_mutation runner-close-operation R004_OPERATION_SCOPE close-operation
case_mutation runner-run-tests-operation R004_OPERATION_SCOPE run-tests-operation
case_mutation runner-finalize-operation R004_OPERATION_SCOPE finalize-operation
case_mutation runner-parallel-operation R004_OPERATION_SCOPE parallel-operation
case_mutation runner-formal-pass-in-check R006_VERDICTS formal-pass-in-check
case_mutation runner-effective-base-in-check R015_CHECK_AUTHORITY effective-base-in-check
case_mutation runner-attempt-in-findings-check R015_CHECK_AUTHORITY attempt-in-findings-check
case_mutation runner-completes-in-check R015_CHECK_AUTHORITY complete-in-check
case_mutation runner-check-status-is-pass R007_OUTPUT_SCHEMA check-status-pass
case_mutation runner-missing-tests-not-applicable R006_VERDICTS missing-not-applicable-status
case_mutation runner-unprefixed-not-applicable R006_VERDICTS unprefixed-not-applicable
case_mutation runner-tool-missing-is-not-applicable R016_NOT_APPLICABLE tool-missing-is-not-applicable
case_mutation runner-command-failure-is-not-applicable R016_NOT_APPLICABLE command-failure-is-not-applicable
case_mutation runner-skips-check-discovery R016_NOT_APPLICABLE missing-discovery
case_mutation runner-prohibits-discovery-actions R016_NOT_APPLICABLE discovery-prohibited
case_mutation runner-treats-reads-as-verification R016_NOT_APPLICABLE reads-are-verification
case_mutation runner-not-applicable-without-invocation R016_NOT_APPLICABLE not-applicable-without-runner
case_mutation runner-not-applicable-with-commands R016_NOT_APPLICABLE not-applicable-with-commands
case_mutation runner-ambiguous-confirmation-field R007_OUTPUT_SCHEMA ambiguous-confirmation-schema
case_mutation runner-not-applicable-without-discovery-schema R007_OUTPUT_SCHEMA not-applicable-no-discovery-schema
case_mutation runner-not-applicable-without-rationale-schema R007_OUTPUT_SCHEMA not-applicable-no-rationale-schema
case_mutation runner-promotes-not-applicable-to-pass R016_NOT_APPLICABLE not-applicable-promoted-to-pass
case_mutation runner-missing-automatic-round R007_OUTPUT_SCHEMA missing-automatic-round-schema
case_mutation codex-claude-fourth-round-divergence R003_EQUIVALENCE fourth-round-input
case_mutation runner-allows-correction R005_READ_ONLY allows-correction
case_mutation adapter-operation-divergence R003_EQUIVALENCE divergent-operations
case_mutation runner-missing-status R007_OUTPUT_SCHEMA missing-status
case_mutation runner-missing-validation-type R007_OUTPUT_SCHEMA missing-type
case_mutation runner-missing-head R007_OUTPUT_SCHEMA missing-head
case_mutation runner-missing-manifest R007_OUTPUT_SCHEMA missing-hashes
case_mutation runner-invalid-hash-rule R008_MANIFEST invalid-hash-rule
case_mutation runner-missing-removed-marker R008_MANIFEST missing-removed-marker
case_mutation runner-missing-overlap R007_OUTPUT_SCHEMA missing-overlap
case_mutation runner-missing-regressions R007_OUTPUT_SCHEMA missing-regressions
case_mutation runner-nonpass-effective-base R006_VERDICTS nonpass-effective-base
case_mutation runner-allows-edit R005_READ_ONLY allows-edit
case_mutation readme-manual-test-step R012_README readme-manual-tests
case_mutation readme-allows-fallback R012_README readme-fallback
case_mutation readme-missing-codex-launcher R012_README readme-missing-codex
case_mutation readme-missing-claude-launcher R012_README readme-missing-claude
case_mutation readme-attempt-for-checks R012_README readme-attempt-for-checks
case_mutation readme-close-calls-runner R012_README readme-close-runner
case_mutation readme-creates-manual-retry R012_README readme-manual-retry
case_mutation readme-prohibits-discovery-actions R012_README readme-prohibits-discovery

echo "PASS: 57 invalid validation-runner mutations rejected by the semantic checker against isolated fixtures"
echo "PASS: focused validation-runner contract suite completed in $((SECONDS - START_SECONDS))s"
