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
    replace(claude, "Não invente resultados", "Você pode estimar resultados")
elif expression == "execute-operation":
    replace_adapters("# Operação", "# Operação\n\n`EXECUTE_SLICE`: execute testes.")
elif expression == "apply-operation":
    replace_adapters("# Operação", "# Operação\n\n`APPLY_FINDINGS`: execute testes.")
elif expression == "close-operation":
    replace_adapters("# Operação", "# Operação\n\n`CLOSE`: valide fechamento.")
elif expression == "finalize-operation":
    replace_adapters("# Operação", "# Operação\n\n`FINALIZE_SLICE`: finalize.")
elif expression == "parallel-operation":
    replace_adapters("# Operação", "# Operação\n\n`PARALLELIZE_SLICES`: avalie.")
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
    replace_adapters("ou `REMOVED`", "")
elif expression == "allows-edit":
    replace_adapters("Não edite código, testes, requisitos, planos ou tasks.", "Edite código quando necessário.")
elif expression == "missing-overlap":
    replace_adapters("Overlap com bases anteriores:\n", "")
elif expression == "missing-regressions":
    replace_adapters("Regressões justificadas executadas:\n", "")
elif expression == "nonpass-effective-base":
    replace_adapters("não proponha Effective Validation Base", "proponha Effective Validation Base")
elif expression == "readme-runner-after-execute":
    replace(readme, "não invocam este agente", "invocam este agente")
elif expression == "readme-fallback":
    replace(readme, "Não existe fallback", "Existe fallback")
elif expression == "readme-missing-codex":
    replace(readme, "slice-validate-codex.md", "validation.md")
elif expression == "readme-missing-claude":
    replace(readme, "slice-validate-claude.md", "validation.md")
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
case_mutation runner-execute-operation R004_OPERATION_SCOPE execute-operation
case_mutation runner-apply-findings-operation R004_OPERATION_SCOPE apply-operation
case_mutation runner-close-operation R004_OPERATION_SCOPE close-operation
case_mutation runner-finalize-operation R004_OPERATION_SCOPE finalize-operation
case_mutation runner-parallel-operation R004_OPERATION_SCOPE parallel-operation
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
case_mutation readme-runner-after-execute R012_README readme-runner-after-execute
case_mutation readme-allows-fallback R012_README readme-fallback
case_mutation readme-missing-codex-launcher R012_README readme-missing-codex
case_mutation readme-missing-claude-launcher R012_README readme-missing-claude

echo "PASS: 30 invalid validation-runner mutations rejected by the semantic checker against isolated fixtures"
echo "PASS: focused validation-runner contract suite completed in $((SECONDS - START_SECONDS))s"
