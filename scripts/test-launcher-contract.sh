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
echo "PASS: accepted 17 canonical launchers"

mutate() {
  local file="$1"
  local expression="$2"
  python3 - "$TMP/prompts/$file" "$expression" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
expression = sys.argv[2]

if expression.startswith("recreate-"):
    path.write_text("launcher legado\n", encoding="utf-8")
    raise SystemExit
if expression == "missing-file":
    path.unlink()
    raise SystemExit
if expression == "swap-platform-content":
    path.write_text(path.with_name("slice-execute-claude.md").read_text(encoding="utf-8"), encoding="utf-8")
    raise SystemExit

text = path.read_text(encoding="utf-8")

def replace(old: str, new: str) -> None:
    global text
    if old not in text:
        raise SystemExit(f"missing mutation source in {path}: {old!r}")
    text = text.replace(old, new, 1)

if expression == "duplicate-spec-path":
    replace("SPEC_PATH={{SPEC_PATH}}\n", "SPEC_PATH={{SPEC_PATH}}\nSPEC_PATH={{SPEC_PATH}}\n")
elif expression == "duplicate-slice":
    replace("SLICE={{SLICE}}\n", "SLICE={{SLICE}}\nSLICE={{SLICE}}\n")
elif expression == "move-required":
    replace("SPEC_PATH={{SPEC_PATH}}\nSLICE={{SLICE}}", "SLICE={{SLICE}}\nSPEC_PATH={{SPEC_PATH}}")
elif expression == "before-context":
    replace("\nContexto adicional (opcional):", "\nLinha arbitrária.\nContexto adicional (opcional):")
elif expression == "after-context":
    text += "Texto adicional.\n"
elif expression == "remove-context":
    replace("\nContexto adicional (opcional):", "")
elif expression == "duplicate-context":
    text += "Contexto adicional (opcional):\n"
elif expression == "extra-instruction":
    replace("\nContexto adicional (opcional):", "\nFaça qualquer refactor necessário.\nContexto adicional (opcional):")
elif expression == "unknown-placeholder":
    replace("SPEC_PATH={{SPEC_PATH}}", "SPEC_PATH={{UNKNOWN}}")
elif expression == "angle-placeholder":
    replace("{{SPEC_PATH}}", "<SPEC_PATH>")
elif expression == "execution-root":
    replace("\nContexto adicional (opcional):", "\nEXECUTION_ROOT={{EXECUTION_ROOT}}\nContexto adicional (opcional):")
elif expression == "mode-in-execution":
    replace("OPERATION=PLAN", "MODE=INIT\nOPERATION=PLAN")
elif expression == "operation-in-lifecycle":
    replace("MODE=CLOSE", "MODE=CLOSE\nOPERATION=CLOSE")
elif expression == "slice-without-slice":
    replace("\nContexto adicional (opcional):", "\nSLICE={{SLICE}}\nContexto adicional (opcional):")
elif expression == "slices-outside-parallel":
    replace("\nContexto adicional (opcional):", "\nSLICES={{SLICES}}\nContexto adicional (opcional):")
elif expression == "codex-with-claude-mention":
    replace("`stnl_validation_runner`", "`stnl_validation_runner` e @agent-stnl-validation-runner")
elif expression == "claude-with-codex-identifier":
    replace("@agent-stnl-validation-runner", "stnl_validation_runner")
elif expression == "codex-hyphenated-identifier":
    replace("stnl_validation_runner", "stnl-validation-runner")
elif expression == "claude-mention-underscore":
    replace("@agent-stnl-validation-runner", "@agent-stnl_validation_runner")
elif expression == "backtick-claude-mention":
    replace("@agent-stnl-validation-runner", "`@agent-stnl-validation-runner`")
elif expression == "code-block-claude-mention":
    replace("@agent-stnl-validation-runner", "```text\n@agent-stnl-validation-runner\n```")
elif expression == "remove-claude-mention":
    replace("@agent-stnl-validation-runner", "o agente")
elif expression == "remove-codex-spawn":
    replace("faça spawn do agente customizado", "use o agente")
elif expression == "optional-delegation":
    replace("delegue obrigatoriamente", "delegue opcionalmente")
elif expression == "fallback":
    replace("Não faça fallback.", "Faça fallback.")
elif expression == "main-context-executes-tests":
    replace("não executa nem repete os testes", "executa e repete os testes")
elif expression == "main-context-repeats-tests":
    replace("não executa nem repete os testes", "não executa e repete os testes")
elif expression == "remove-evidence-exclusivity":
    replace("usa somente a evidência retornada", "usa a evidência retornada")
elif expression == "redo-validation":
    replace("não refaz a validação", "refaz a validação")
elif expression == "second-verdict":
    replace("não emite outro veredito", "emite outro veredito")
elif expression == "substitute-promote-status":
    replace("nem substitua, suavize ou promova o resultado", "e substitua, suavize ou promova o resultado")
elif expression == "remove-blocked":
    replace("retorne `BLOCKED`", "retorne um aviso")
elif expression == "close-with-slice":
    replace("SPEC_PATH={{SPEC_PATH}}\n", "SPEC_PATH={{SPEC_PATH}}\nSLICE={{SLICE}}\n")
elif expression == "slice-without-required-slice":
    replace("SLICE={{SLICE}}\n", "")
elif expression == "runner-in-shared":
    replace("\nContexto adicional (opcional):", "\nstnl_validation_runner\n\nContexto adicional (opcional):")
elif expression == "duplicate-canonical-line":
    replace("SPEC_PATH={{SPEC_PATH}}\n", "SPEC_PATH={{SPEC_PATH}}\nSPEC_PATH={{SPEC_PATH}}\n")
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
case_mutation duplicate-slice slice-execute-codex.md duplicate-slice
case_mutation required-placeholder-wrong-position slice-execute-codex.md move-required
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
case_mutation recreated-mixed-slice-execute slice-execute.md recreate-slice-execute
case_mutation recreated-mixed-slice-validate slice-validate.md recreate-slice-validate
case_mutation missing-codex-launcher slice-execute-codex.md missing-file
case_mutation missing-claude-launcher slice-execute-claude.md missing-file
case_mutation codex-containing-claude-mention slice-execute-codex.md codex-with-claude-mention
case_mutation claude-containing-codex-identifier slice-execute-claude.md claude-with-codex-identifier
case_mutation codex-hyphenated-identifier slice-execute-codex.md codex-hyphenated-identifier
case_mutation claude-underscore-mention slice-execute-claude.md claude-mention-underscore
case_mutation backticked-claude-mention slice-execute-claude.md backtick-claude-mention
case_mutation code-block-claude-mention slice-execute-claude.md code-block-claude-mention
case_mutation removed-claude-mention slice-execute-claude.md remove-claude-mention
case_mutation removed-codex-spawn slice-execute-codex.md remove-codex-spawn
case_mutation optional-delegation slice-execute-claude.md optional-delegation
case_mutation fallback-authorized slice-execute-codex.md fallback
case_mutation main-context-executes-tests slice-execute-codex.md main-context-executes-tests
case_mutation main-context-repeats-tests slice-apply-findings-claude.md main-context-repeats-tests
case_mutation removed-evidence-exclusivity slice-execute-codex.md remove-evidence-exclusivity
case_mutation main-context-redoes-validation slice-validate-codex.md redo-validation
case_mutation main-context-emits-second-verdict slice-validate-claude.md second-verdict
case_mutation status-substitution-or-promotion slice-validate-codex.md substitute-promote-status
case_mutation removed-blocked-result slice-validate-claude.md remove-blocked
case_mutation slice-in-execution-close execution-close-codex.md close-with-slice
case_mutation missing-slice-in-slice-operation slice-validate-claude.md slice-without-required-slice
case_mutation runner-in-shared-launcher execution-plan.md runner-in-shared
case_mutation duplicated-canonical-line slice-apply-findings-codex.md duplicate-canonical-line
case_mutation swapped-platform-content slice-execute-codex.md swap-platform-content

echo "PASS: 41 invalid launcher mutations rejected"
bash "$ROOT/scripts/test-validation-runner-contract.sh"
