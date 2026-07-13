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
elif expression == "remove-validation-runner":
    text = "\n".join(line for line in text.splitlines() if "stnl-validation-runner" not in line) + "\n"
elif expression == "wrong-validation-runner-name":
    text = text.replace("stnl-validation-runner", "wrong-validation-runner", 1)
elif expression == "codex-uses-logical-hyphen":
    text = text.replace("name é stnl_validation_runner", "name é stnl-validation-runner", 1)
elif expression == "codex-hyphenated-identifier":
    text = text.replace("name é stnl_validation_runner", "name é stnl_validation-runner", 1)
elif expression == "codex-divergent-identifier":
    text = text.replace("name é stnl_validation_runner", "name é other_validation_runner", 1)
elif expression == "remove-claude-mention":
    text = text.replace("@agent-stnl-validation-runner", "", 1)
elif expression == "wrong-claude-mention":
    text = text.replace("@agent-stnl-validation-runner", "@agent-wrong-validation-runner", 1)
elif expression == "claude-mention-underscore":
    text = text.replace("@agent-stnl-validation-runner", "@agent-stnl_validation_runner", 1)
elif expression == "claude-only-codex-name":
    text = text.replace("@agent-stnl-validation-runner", "stnl_validation_runner", 1)
elif expression == "swap-platform-identifiers":
    text = text.replace("@agent-stnl-validation-runner", "@agent-stnl_validation_runner", 1)
    text = text.replace("name é stnl_validation_runner", "name é stnl-validation-runner", 1)
elif expression == "remove-logical-identity":
    text = text.replace("papel conceitual stnl-validation-runner, materializado assim:", "agente de validação, materializado assim:", 1)
elif expression == "remove-claude-agent-prefix":
    text = text.replace("@agent-stnl-validation-runner", "stnl-validation-runner", 1)
elif expression == "backtick-claude-mention":
    text = text.replace("@agent-stnl-validation-runner", "`@agent-stnl-validation-runner`", 1)
elif expression == "code-block-claude-mention":
    text = text.replace("@agent-stnl-validation-runner", "```text\n@agent-stnl-validation-runner\n```", 1)
elif expression == "remove-codex-spawn":
    text = text.replace("no Codex, faça spawn do agente customizado cujo name é stnl_validation_runner.", "no Codex, use o agente.", 1)
elif expression == "optional-delegation":
    text = text.replace("Selecione obrigatoriamente", "Selecione quando possível", 1)
elif expression == "validation-runner-fallback":
    text = text.replace("sem fallback,", "com fallback,", 1)
elif expression == "main-context-executes-tests":
    text = text.replace("somente o agente executa ou repete testes", "o contexto principal pode executar testes", 1)
elif expression == "main-context-repeats-tests":
    text = text.replace("sem fallback, repetição,", "sem fallback, mas com repetição,", 1)
elif expression == "remove-test-evidence-exclusivity":
    text = text.replace("somente o agente executa ou repete testes e produz a evidência", "o agente executa ou repete testes", 1)
elif expression == "main-context-redoes-validation":
    text = text.replace("nova validação", "validação adicional", 1)
elif expression == "remove-status-preservation":
    text = text.replace("PASS, NEEDS_FIX, BLOCKED ou findings", "resultados", 1)
elif expression == "substitute-verdict":
    text = text.replace("sem fallback, testes repetidos, nova validação, segundo veredito, substituição,", "sem fallback, testes repetidos, nova validação, segundo veredito e com substituição,", 1)
elif expression == "remove-wait":
    text = text.replace("Aguarde o retorno válido: ", "", 1)
elif expression == "duplicate-validation-runner":
    line = next(line for line in text.splitlines() if line.startswith("Selecione obrigatoriamente"))
    text = text.replace(line, line + "\n" + line, 1)
elif expression == "validation-runner-in-unauthorized-launcher":
    line = "Selecione obrigatoriamente o papel conceitual stnl-validation-runner, materializado assim: no Claude Code, @agent-stnl-validation-runner; no Codex, faça spawn do agente customizado cujo name é stnl_validation_runner."
    text = text.replace("\nContexto adicional (opcional):", "\n" + line + "\nContexto adicional (opcional):", 1)
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
case_mutation missing-validation-runner-execute slice-execute.md remove-validation-runner
case_mutation missing-validation-runner-validate slice-validate.md remove-validation-runner
case_mutation wrong-validation-runner-name slice-execute.md wrong-validation-runner-name
case_mutation codex-using-logical-hyphen slice-execute.md codex-uses-logical-hyphen
case_mutation codex-using-hyphenated-identifier slice-execute.md codex-hyphenated-identifier
case_mutation codex-using-divergent-identifier slice-execute.md codex-divergent-identifier
case_mutation missing-claude-mention slice-execute.md remove-claude-mention
case_mutation wrong-claude-mention slice-execute.md wrong-claude-mention
case_mutation claude-mention-using-underscore slice-execute.md claude-mention-underscore
case_mutation claude-using-only-codex-name slice-execute.md claude-only-codex-name
case_mutation swapped-platform-identifiers slice-execute.md swap-platform-identifiers
case_mutation missing-logical-identity slice-execute.md remove-logical-identity
case_mutation missing-claude-agent-prefix slice-execute.md remove-claude-agent-prefix
case_mutation backticked-claude-mention slice-execute.md backtick-claude-mention
case_mutation code-block-claude-mention slice-execute.md code-block-claude-mention
case_mutation missing-codex-spawn slice-execute.md remove-codex-spawn
case_mutation optional-validation-delegation slice-execute.md optional-delegation
case_mutation validation-runner-fallback slice-validate.md validation-runner-fallback
case_mutation main-context-executes-tests slice-execute.md main-context-executes-tests
case_mutation main-context-repeats-tests slice-apply-findings.md main-context-repeats-tests
case_mutation missing-test-evidence-exclusivity slice-execute.md remove-test-evidence-exclusivity
case_mutation main-context-redoes-validation slice-validate.md main-context-redoes-validation
case_mutation missing-status-preservation slice-validate.md remove-status-preservation
case_mutation verdict-substitution slice-validate.md substitute-verdict
case_mutation missing-agent-wait slice-validate.md remove-wait
case_mutation duplicated-validation-runner slice-apply-findings.md duplicate-validation-runner
case_mutation validation-runner-in-unauthorized-launcher execution-plan.md validation-runner-in-unauthorized-launcher

echo "PASS: 42 invalid launcher mutations rejected"
bash "$ROOT/scripts/test-validation-runner-contract.sh"
