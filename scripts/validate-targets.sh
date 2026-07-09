#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
LEGACY_TEMPLATE_NAME="prom""tps"
LEGACY_TEMPLATE_DIR="templates/$LEGACY_TEMPLATE_NAME"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cd "$ROOT"

command -v "$PYTHON_BIN" >/dev/null 2>&1 || fail "PYTHON_BIN is unavailable: $PYTHON_BIN"

# Packaging and prompt templates
if find . \( -name .DS_Store -o -name '._*' -o -name __MACOSX \) -print -quit | grep -q .; then
  fail "packaging metadata remains"
fi

test -d templates/prompts || fail "templates/prompts directory is missing"
test ! -e "$LEGACY_TEMPLATE_DIR" || fail "legacy template path remains: $LEGACY_TEMPLATE_DIR"
for name in spec-close spec-init spec-planning spec-resume; do
  test -f "templates/prompts/$name.md" || fail "missing templates/prompts/$name.md"
done
if grep -R -q --exclude='*.zip' --exclude-dir=.git "$LEGACY_TEMPLATE_NAME" .; then
  fail "legacy template reference remains"
fi

# Codex target
grep -Eq '^max_depth[[:space:]]*=[[:space:]]*2$' targets/codex/.codex/config.toml \
  || fail "Codex max_depth is not 2"
if grep -R -n '^sandbox_mode[[:space:]]*=' targets/codex/.codex >/dev/null; then
  fail "Codex target mixes sandbox_mode with permission profiles"
fi
for profile in sentinel-read-only sentinel-workspace; do
  grep -Fq "[permissions.$profile]" targets/codex/.codex/config.toml \
    || fail "missing Codex profile $profile"
done
for agent in sentinel-orchestrator sentinel-reviewer; do
  grep -Fq 'default_permissions = "sentinel-read-only"' "targets/codex/.codex/agents/$agent.toml" \
    || fail "$agent is not read-only"
done
for agent in sentinel-planner sentinel-test-planner sentinel-coder sentinel-finalizer; do
  grep -Fq 'default_permissions = "sentinel-workspace"' "targets/codex/.codex/agents/$agent.toml" \
    || fail "$agent cannot write within the workspace"
done

codex_validator=targets/codex/.codex/agents/sentinel-validator.toml
grep -Fq 'default_permissions = "sentinel-workspace"' "$codex_validator" \
  || fail "sentinel-validator must use sentinel-workspace to execute validation commands"
for rule in \
  'Approved validation commands may generate execution artifacts' \
  'Never edit code, product files, tests, contracts, plans, or spec files.' \
  'changes files outside its expected execution artifacts, return BLOCKED or NEEDS_FIX' \
  'Inspect and report every dirty diff produced by validation.'; do
  grep -Fq "$rule" "$codex_validator" \
    || fail "sentinel-validator is missing its workspace restriction: $rule"
done
for sensitive in '.env' 'secrets' 'credentials' '.aws' '.ssh'; do
  grep -Fq "$sensitive" targets/codex/.codex/config.toml \
    || fail "missing Codex deny rule for $sensitive"
done

if "$PYTHON_BIN" -c 'import tomllib' >/dev/null 2>&1; then
  "$PYTHON_BIN" - <<'PY'
from pathlib import Path
import tomllib

for path in Path("targets/codex/.codex").rglob("*.toml"):
    with path.open("rb") as source:
        tomllib.load(source)
PY
elif command -v codex >/dev/null 2>&1; then
  (cd targets/codex && codex features list >/dev/null)
else
  fail "TOML validation requires PYTHON_BIN with tomllib or Codex CLI"
fi

# Claude Code target: JSON, frontmatter, allowlist, and delegation boundaries
"$PYTHON_BIN" - <<'PY'
import json
import re
from pathlib import Path


def frontmatter(path: Path) -> dict[str, str]:
    text = path.read_text()
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        raise SystemExit(f"invalid frontmatter start: {path}")
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise SystemExit(f"missing frontmatter end: {path}") from error
    data: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip() or line.startswith((" ", "\t")):
            raise SystemExit(f"unsupported or blank frontmatter line in {path}: {line!r}")
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*):\s+(.+)", line)
        if not match:
            raise SystemExit(f"invalid frontmatter line in {path}: {line!r}")
        key, value = match.groups()
        if key in data:
            raise SystemExit(f"duplicate frontmatter key in {path}: {key}")
        if value.startswith("[") != value.endswith("]"):
            raise SystemExit(f"unbalanced frontmatter list in {path}: {key}")
        data[key] = value
    return data


settings_path = Path("targets/claude-code/.claude/settings.json")
try:
    settings = json.loads(settings_path.read_text())
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid JSON in {settings_path}: {error}") from error
if settings.get("agent") != "sentinel-orchestrator":
    raise SystemExit("Claude settings do not select sentinel-orchestrator")
denied = set(settings.get("permissions", {}).get("deny", []))
required_denials = {"Agent(Explore)", "Agent(Plan)", "Agent(general-purpose)"}
if not required_denials <= denied:
    raise SystemExit("Claude settings are missing built-in Agent denials")

agent_dir = Path("targets/claude-code/.claude/agents")
agents = sorted(agent_dir.glob("*.md"))
if not agents:
    raise SystemExit("Claude agents are missing")
metadata = {path.name: frontmatter(path) for path in agents}
required_keys = {"name", "description", "tools", "model"}
for name, data in metadata.items():
    if not required_keys <= data.keys():
        raise SystemExit(f"Claude agent frontmatter is incomplete: {name}")

expected_tools = (
    "Read, Glob, Agent(sentinel-planner, sentinel-test-planner, sentinel-coder, "
    "sentinel-validator, sentinel-reviewer, sentinel-finalizer)"
)
orchestrator = metadata.get("sentinel-orchestrator.md")
if orchestrator is None or orchestrator.get("tools") != expected_tools:
    raise SystemExit("Claude orchestrator Agent allowlist differs from the six specialists")
for name, data in metadata.items():
    if name != "sentinel-orchestrator.md" and re.search(r"(?:^|[, ])Agent(?:\(|[, ]|$)", data["tools"]):
        raise SystemExit(f"Claude specialist can delegate: {name}")
PY

# Copilot target: orchestrator-first invocation and static smoke checks
"$PYTHON_BIN" - <<'PY'
import re
from pathlib import Path


def read_agent(path: Path) -> tuple[dict[str, str], str]:
    text = path.read_text()
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        raise SystemExit(f"invalid frontmatter start: {path}")
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise SystemExit(f"missing frontmatter end: {path}") from error
    data: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip() or line.startswith((" ", "\t")):
            raise SystemExit(f"unsupported or blank frontmatter line in {path}: {line!r}")
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*):\s+(.+)", line)
        if not match:
            raise SystemExit(f"invalid frontmatter line in {path}: {line!r}")
        key, value = match.groups()
        if key in data:
            raise SystemExit(f"duplicate frontmatter key in {path}: {key}")
        if value.startswith("[") != value.endswith("]"):
            raise SystemExit(f"unbalanced frontmatter list in {path}: {key}")
        if key in {"disable-model-invocation", "user-invocable"} and value not in {"true", "false"}:
            raise SystemExit(f"invalid boolean in {path}: {key}")
        data[key] = value
    return data, "\n".join(lines[end + 1 :])


agent_dir = Path("targets/copilot/.github/agents")
paths = sorted(agent_dir.glob("*.agent.md"))
if not paths:
    raise SystemExit("Copilot agents are missing")
agents = {path.name: read_agent(path) for path in paths}
required_keys = {
    "name",
    "description",
    "tools",
    "disable-model-invocation",
    "user-invocable",
}
for name, (data, _) in agents.items():
    if not required_keys <= data.keys():
        raise SystemExit(f"Copilot agent frontmatter is incomplete: {name}")

orchestrator_name = "sentinel-orchestrator.agent.md"
orchestrator = agents.get(orchestrator_name)
if orchestrator is None:
    raise SystemExit("Copilot orchestrator is missing")
invocable = [name for name, (data, _) in agents.items() if data["user-invocable"] == "true"]
if invocable != [orchestrator_name]:
    raise SystemExit(f"Copilot user-invocable agents must contain only the orchestrator: {invocable}")

orchestrator_data, orchestrator_body = orchestrator
orchestrator_tools = {item.strip().lower() for item in orchestrator_data["tools"].strip("[]").split(",")}
if "agent" not in orchestrator_tools:
    raise SystemExit("Copilot orchestrator lacks the agent tool")
if not re.search(r"invokes? only the next eligible agent", orchestrator_body, re.IGNORECASE):
    raise SystemExit("Copilot orchestrator lacks the next-eligible-agent restriction")

negative_prefix = re.compile(r"\b(?:do not|does not|must not|never|cannot|may not)\b", re.IGNORECASE)
delegation = re.compile(r"\b(?:invoke|delegate|call)\b.{0,80}\b(?:agent|sentinel-[a-z-]+)\b", re.IGNORECASE)
direct_call = re.compile(r"\b(?:user|developer)\b.{0,80}\b(?:invoke|call)\b|\b(?:invoke|call)\b.{0,40}\bdirectly\b", re.IGNORECASE)
for name, (data, body) in agents.items():
    if name == orchestrator_name:
        continue
    if data["user-invocable"] != "false":
        raise SystemExit(f"Copilot specialist is user-invocable: {name}")
    if data["disable-model-invocation"] != "false":
        raise SystemExit(f"Copilot specialist cannot be invoked programmatically: {name}")
    tools = {item.strip().lower() for item in data["tools"].strip("[]").split(",")}
    if "agent" in tools:
        raise SystemExit(f"Copilot specialist has the agent tool: {name}")
    for line in body.splitlines():
        if (delegation.search(line) or direct_call.search(line)) and not negative_prefix.search(line):
            raise SystemExit(f"Copilot specialist contains a delegation/direct-call instruction: {name}: {line}")

instructions_dir = Path("targets/copilot/.github/instructions")
known_redundant = {
    "sentinel-evidence.instructions.md",
    "sentinel-path-scope.instructions.md",
    "sentinel-skill-loading.instructions.md",
    "sentinel-workflows.instructions.md",
}
for path in instructions_dir.glob("*.instructions.md") if instructions_dir.exists() else []:
    if path.name in known_redundant:
        raise SystemExit(f"redundant Copilot instruction was reintroduced: {path}")
    if re.search(r"^applyTo:\s*['\"]?\*\*['\"]?\s*$", path.read_text(), re.MULTILINE):
        raise SystemExit(f"global Copilot instruction was reintroduced: {path}")
PY

copilot_policy=targets/copilot/AGENTS.md
for rule in \
  '## Workflow and gates' \
  '## Contracts and ownership' \
  '## Scope, evidence, and context' \
  'Handoffs are short, textual, disposable, and non-persistent.' \
  'After an interruption, reload the compact spec index'; do
  grep -Fq "$rule" "$copilot_policy" || fail "Copilot AGENTS.md is missing a critical rule: $rule"
done
grep -Fq 'acceptance criteria and DoR/DoD' "$copilot_policy" \
  || fail "Copilot AGENTS.md is missing evidence-to-DoR/DoD coverage"

# Modular spec workspace contract
test -f skills/stnl-spec-lifecycle-manager/references/spec-workspace.md \
  || fail "missing modular spec workspace reference"
for template in \
  feature_spec \
  shared-acceptance-criteria \
  shared-decisions \
  shared-constraints \
  shared-risks \
  shared-questions \
  slice \
  traceability \
  qa-checklist \
  resume-notes \
  closed-feature_spec; do
  test -f "skills/stnl-spec-lifecycle-manager/templates/$template.template.md" \
    || fail "missing modular template: $template"
done
for policy in targets/codex/AGENTS.md targets/claude-code/CLAUDE.md targets/copilot/AGENTS.md; do
  grep -Eq 'modular spec workspace|spec workspace is modular' "$policy" \
    || fail "$policy does not describe the modular spec workspace"
  grep -Fq 'slice context package' "$policy" \
    || fail "$policy does not forbid persistent slice context packages"
done
for finalizer in \
  agents/base/finalizer.md \
  targets/codex/.codex/agents/sentinel-finalizer.toml \
  targets/claude-code/.claude/agents/sentinel-finalizer.md \
  targets/copilot/.github/agents/sentinel-finalizer.agent.md; do
  grep -Fq 'shared/acceptance-criteria.md' "$finalizer" \
    || fail "$finalizer does not protect acceptance criteria"
  grep -Fq 'lifecycle/resume-notes.md' "$finalizer" \
    || fail "$finalizer does not include modular lifecycle allowlist"
done
if grep -R -n --exclude-dir=.git --exclude='*.zip' 'spec-close-inputs.md' agents targets skills templates >/dev/null; then
  fail "legacy spec-close-inputs.md reference remains"
fi

echo "PASS: target alignment checks"
