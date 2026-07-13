#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$ROOT/templates/subagents" "$TMP/subagents"

run_validator() {
  SUBAGENT_TEMPLATE_ROOT="$TMP/subagents" bash "$ROOT/scripts/validate-targets.sh" >/dev/null
}

expect_rejected() {
  local name="$1"
  if run_validator; then
    echo "FAIL: invalid validation-runner mutation accepted: $name" >&2
    exit 1
  fi
  echo "PASS: rejected $name"
}

run_validator
echo "PASS: accepted canonical validation-runner templates"

mutate() {
  local expression="$1"
  python3 - "$TMP/subagents" "$expression" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
expression = sys.argv[2]
codex = root / "codex/.codex/agents/stnl_validation_runner.toml"
claude = root / "claude-code/.claude/agents/stnl-validation-runner.md"

def replace(path: Path, old: str, new: str, count: int = 1) -> None:
    text = path.read_text(encoding="utf-8")
    if text.count(old) < count:
        raise SystemExit(f"missing mutation source in {path}: {old!r}")
    path.write_text(text.replace(old, new, count), encoding="utf-8")

if expression == "codex-wrong-model":
    replace(codex, 'model = "gpt-5.4-mini"', 'model = "gpt-5.4"')
elif expression == "codex-old-hyphen-filename":
    codex.rename(codex.with_name("stnl-validation-runner.toml"))
elif expression == "codex-hyphen-name":
    replace(codex, 'name = "stnl_validation_runner"', 'name = "stnl-validation-runner"')
elif expression == "codex-invalid-name-characters":
    replace(codex, 'name = "stnl_validation_runner"', 'name = "stnl.Validation_Runner!"')
elif expression == "codex-wrong-effort":
    replace(codex, 'model_reasoning_effort = "medium"', 'model_reasoning_effort = "high"')
elif expression == "codex-empty-instructions":
    text = codex.read_text(encoding="utf-8")
    start = text.index('developer_instructions = """')
    end = text.index('"""', start + len('developer_instructions = """')) + 3
    codex.write_text(text[:start] + 'developer_instructions = ""\n' + text[end:], encoding="utf-8")
elif expression == "codex-allows-code-correction":
    replace(codex, "Não implemente, não corrija e não finalize trabalho.", "Você pode corrigir código.")
    replace(claude, "Não implemente, não corrija e não finalize trabalho.", "Você pode corrigir código.")
elif expression == "codex-allows-nested-subagents":
    replace(codex, "max_depth = 1", "max_depth = 2")
elif expression == "claude-wrong-name":
    replace(claude, "name: stnl-validation-runner", "name: divergent-runner")
elif expression == "claude-underscore-filename":
    claude.rename(claude.with_name("stnl_validation_runner.md"))
elif expression == "claude-underscore-name":
    replace(claude, "name: stnl-validation-runner", "name: stnl_validation_runner")
elif expression == "claude-write":
    replace(claude, "tools: Read, Glob, Grep, Bash", "tools: Read, Glob, Grep, Bash, Write")
elif expression == "claude-edit":
    replace(claude, "tools: Read, Glob, Grep, Bash", "tools: Read, Glob, Grep, Bash, Edit")
elif expression == "claude-agent":
    replace(claude, "tools: Read, Glob, Grep, Bash", "tools: Read, Glob, Grep, Bash, Agent")
elif expression == "claude-wrong-model":
    replace(claude, "model: haiku", "model: sonnet")
elif expression == "missing-claude-adapter":
    claude.unlink()
elif expression == "missing-required-status":
    replace(codex, "PASS | NEEDS_FIX | BLOCKED", "PASS | BLOCKED")
    replace(claude, "PASS | NEEDS_FIX | BLOCKED", "PASS | BLOCKED")
elif expression == "material-contract-divergence":
    replace(claude, "Não implemente, não corrija e não finalize trabalho.", "Não implemente trabalho.")
elif expression == "prohibited-target-or-sentinel-reference":
    replace(codex, "CONTRATO_CANONICO=stnl-validation-runner/v1", "CONTRATO_CANONICO=stnl-validation-runner/v1 targets/ sentinel-validator")
    replace(claude, "CONTRATO_CANONICO=stnl-validation-runner/v1", "CONTRATO_CANONICO=stnl-validation-runner/v1 targets/ sentinel-validator")
elif expression == "readme-missing-claude-mention":
    replace(root / "README.md", "@agent-stnl-validation-runner", "stnl-validation-runner")
elif expression == "readme-missing-codex-spawn":
    replace(root / "README.md", "faz spawn do agente customizado `stnl_validation_runner`", "usa o agente")
elif expression == "readme-swaps-platform-names":
    replace(
        root / "README.md",
        "No Codex, o launcher faz spawn do agente customizado `stnl_validation_runner`.",
        "No Codex, o launcher faz spawn do agente customizado `stnl-validation-runner`.",
    )
elif expression == "readme-omits-platform-specific-launchers":
    replace(
        root / "README.md",
        "Os launchers são específicos por plataforma.",
        "Os launchers usam o mesmo formato.",
    )
elif expression == "readme-allows-fallback":
    replace(root / "README.md", "Não existe fallback.", "Existe fallback.")
elif expression == "readme-allows-cross-platform-use":
    replace(root / "README.md", "Não use um launcher de uma plataforma na outra.", "Use qualquer launcher em qualquer plataforma.")
elif expression == "readme-removes-blocked-contract":
    replace(root / "README.md", "o resultado é `BLOCKED`. Não existe fallback.", "o resultado é pendente.")
elif expression == "readme-removes-manual-smoke":
    replace(root / "README.md", "## Smoke test manual", "## Operação")
elif expression == "readme-removes-installation-section":
    replace(
        root / "README.md",
        "## Instalação\n\nA cópia parte da pasta `templates/subagents/` deste repositório. Copie somente o adaptador da plataforma usada para a raiz do projeto:\n\n- Codex: copie o conteúdo de `codex/`. O arquivo resultante deve ser `.codex/agents/stnl_validation_runner.toml`.\n- Claude Code: copie o conteúdo de `claude-code/`. O arquivo resultante deve ser `.claude/agents/stnl-validation-runner.md`.\n\nNão copie os dois adaptadores para o mesmo projeto.\n\n",
        "",
    )
elif expression == "readme-missing-codex-source":
    replace(root / "README.md", "- Codex: copie o conteúdo de `codex/`. O arquivo resultante deve ser `.codex/agents/stnl_validation_runner.toml`.\n", "")
elif expression == "readme-wrong-codex-destination":
    replace(root / "README.md", ".codex/agents/stnl_validation_runner.toml", ".codex/agents/stnl-validation-runner.toml")
elif expression == "readme-missing-claude-source":
    replace(root / "README.md", "- Claude Code: copie o conteúdo de `claude-code/`. O arquivo resultante deve ser `.claude/agents/stnl-validation-runner.md`.\n", "")
elif expression == "readme-wrong-claude-destination":
    replace(root / "README.md", ".claude/agents/stnl-validation-runner.md", ".claude/agents/stnl_validation_runner.md")
elif expression == "readme-swaps-installation-destinations":
    replace(
        root / "README.md",
        "- Codex: copie o conteúdo de `codex/`. O arquivo resultante deve ser `.codex/agents/stnl_validation_runner.toml`.\n- Claude Code: copie o conteúdo de `claude-code/`. O arquivo resultante deve ser `.claude/agents/stnl-validation-runner.md`.",
        "- Codex: copie o conteúdo de `codex/`. O arquivo resultante deve ser `.claude/agents/stnl-validation-runner.md`.\n- Claude Code: copie o conteúdo de `claude-code/`. O arquivo resultante deve ser `.codex/agents/stnl_validation_runner.toml`.",
    )
elif expression == "readme-allows-copying-both-adapters":
    replace(root / "README.md", "Não copie os dois adaptadores para o mesmo projeto.", "Copie os dois adaptadores para o mesmo projeto.")
elif expression == "registry-wrong-codex-physical-name":
    codex.rename(codex.with_name("other_validation_runner.toml"))
else:
    raise SystemExit(f"unknown mutation: {expression}")
PY
}

case_mutation() {
  local name="$1"
  local expression="$2"
  rm -rf "$TMP/subagents"
  cp -R "$ROOT/templates/subagents" "$TMP/subagents"
  mutate "$expression"
  expect_rejected "$name"
}

case_mutation codex-wrong-model codex-wrong-model
case_mutation codex-old-hyphen-filename codex-old-hyphen-filename
case_mutation codex-hyphen-name codex-hyphen-name
case_mutation codex-invalid-name-characters codex-invalid-name-characters
case_mutation codex-wrong-effort codex-wrong-effort
case_mutation codex-empty-instructions codex-empty-instructions
case_mutation codex-allows-code-correction codex-allows-code-correction
case_mutation codex-allows-nested-subagents codex-allows-nested-subagents
case_mutation claude-wrong-name claude-wrong-name
case_mutation claude-underscore-filename claude-underscore-filename
case_mutation claude-underscore-name claude-underscore-name
case_mutation claude-write claude-write
case_mutation claude-edit claude-edit
case_mutation claude-agent claude-agent
case_mutation claude-wrong-model claude-wrong-model
case_mutation missing-claude-adapter missing-claude-adapter
case_mutation missing-required-status missing-required-status
case_mutation material-contract-divergence material-contract-divergence
case_mutation prohibited-target-or-sentinel-reference prohibited-target-or-sentinel-reference
case_mutation readme-missing-claude-mention readme-missing-claude-mention
case_mutation readme-missing-codex-spawn readme-missing-codex-spawn
case_mutation readme-swaps-platform-names readme-swaps-platform-names
case_mutation readme-omits-platform-specific-launchers readme-omits-platform-specific-launchers
case_mutation readme-allows-fallback readme-allows-fallback
case_mutation readme-allows-cross-platform-use readme-allows-cross-platform-use
case_mutation readme-removes-blocked-contract readme-removes-blocked-contract
case_mutation readme-removes-manual-smoke readme-removes-manual-smoke
case_mutation readme-removes-installation-section readme-removes-installation-section
case_mutation readme-missing-codex-source readme-missing-codex-source
case_mutation readme-wrong-codex-destination readme-wrong-codex-destination
case_mutation readme-missing-claude-source readme-missing-claude-source
case_mutation readme-wrong-claude-destination readme-wrong-claude-destination
case_mutation readme-swaps-installation-destinations readme-swaps-installation-destinations
case_mutation readme-allows-copying-both-adapters readme-allows-copying-both-adapters
case_mutation registry-wrong-codex-physical-name registry-wrong-codex-physical-name

echo "PASS: 35 invalid validation-runner mutations rejected"
