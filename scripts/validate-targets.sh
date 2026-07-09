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

# Packaging metadata
if find . -path ./.git -prune -o \( -name .DS_Store -o -name '._*' -o -name __MACOSX -o -name Thumbs.db \) -print -quit | grep -q .; then
  fail "packaging metadata remains"
fi

# Copyable prompts
test -d templates/prompts || fail "templates/prompts directory is missing"
test ! -e "$LEGACY_TEMPLATE_DIR" || fail "legacy template path remains: $LEGACY_TEMPLATE_DIR"
for name in spec-init spec-resume spec-planning spec-close execution-plan execution-plan-review execution-tasks phase-execute phase-validate phase-fix phase-commit phase-parallel execution-close; do
  test -f "templates/prompts/$name.md" || fail "missing templates/prompts/$name.md"
done
if grep -R -q --exclude-dir=.git "$LEGACY_TEMPLATE_NAME" .; then
  fail "legacy template reference remains"
fi

# Static contract validation
"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import json
import re
from pathlib import Path

try:
    import tomllib as _tomllib
except ModuleNotFoundError:
    _tomllib = None

ROOT = Path(".")
TEXT_ROOTS = [Path("agents"), Path("targets"), Path("skills"), Path("templates"), Path("scripts")]
ALLOWED_HANDOFF = {"PASS", "BLOCKED", "NEEDS_APPROVAL", "NEEDS_FIX", "NEEDS_REPLAN", "NEEDS_RETEST_PLAN", "NEEDS_RESUME"}
ALLOWED_MODES = {"INIT", "RESUME", "PLANNING", "CLOSE"}
SKILL_RESOURCE_FOLDERS = [
    Path("skills/stnl-spec-lifecycle-manager/references"),
    Path("skills/stnl-spec-lifecycle-manager/templates"),
    Path("skills/stnl-spec-lifecycle-manager/examples"),
    Path("skills/stnl-spec-lifecycle-manager/evals"),
    Path("skills/stnl-spec-execution-manager/references"),
    Path("skills/stnl-spec-execution-manager/templates"),
    Path("skills/stnl-spec-execution-manager/examples"),
    Path("skills/stnl-spec-execution-manager/evals"),
]
LEGACY_ROLE = "final" "izer"
LEGACY_AGENT = "sentinel-" + LEGACY_ROLE
LEGACY_BASE = Path("agents/base") / f"{LEGACY_ROLE}.md"
LEGACY_FILES = [
    LEGACY_BASE,
    Path("targets/codex/.codex/agents") / f"{LEGACY_AGENT}.toml",
    Path("targets/claude-code/.claude/agents") / f"{LEGACY_AGENT}.md",
    Path("targets/copilot/.github/agents") / f"{LEGACY_AGENT}.agent.md",
]
LEGACY_TOKENS = [
    LEGACY_AGENT,
    str(LEGACY_BASE),
    "-> " + LEGACY_ROLE,
    LEGACY_ROLE + " allowlist",
    "spec-close-" "inputs.md",
    "close-" "readiness.md",
    "MODE=" "COMPLETE",
    "MODE=" "COMMIT",
]
REMOVED_STATUSES = [
    "closed_" "with_residuals",
    "not_" "closed",
    "ready-to-" "close",
    "not-ready-to-" "close",
]


def fail(message: str) -> None:
    raise SystemExit(message)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def load_toml(path: Path) -> dict:
    text = read_text(path)
    if _tomllib is not None:
        return _tomllib.loads(text)

    data: dict = {}
    section: list[str] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        raw = lines[index]
        line = raw.strip()
        index += 1
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = [part.strip('"') for part in line.strip("[]").split(".")]
            cursor = data
            for part in section:
                cursor = cursor.setdefault(part, {})
            continue
        if "=" not in line:
            fail(f"invalid TOML line in {path}: {raw!r}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value.startswith('"""'):
            collected = [value[3:]]
            while not collected[-1].endswith('"""'):
                if index >= len(lines):
                    fail(f"unterminated TOML multiline string in {path}: {key}")
                collected.append(lines[index])
                index += 1
            collected[-1] = collected[-1][:-3]
            parsed: object = "\n".join(collected)
        elif value.startswith('"') and value.endswith('"'):
            parsed = value[1:-1]
        elif re.fullmatch(r"\d+", value):
            parsed = int(value)
        else:
            fail(f"unsupported TOML value in {path}: {raw!r}")
        cursor = data
        for part in section:
            cursor = cursor.setdefault(part, {})
        cursor[key] = parsed
    return data


def iter_text_files() -> list[Path]:
    files: list[Path] = []
    for root in TEXT_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.is_file() and ".git" not in path.parts:
                try:
                    path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    continue
                files.append(path)
    return files


all_text = {path: read_text(path) for path in iter_text_files()}

# Removed legacy agent and terms
for path in LEGACY_FILES:
    if path.exists():
        fail(f"legacy agent file remains: {path}")
for path, text in all_text.items():
    for token in LEGACY_TOKENS:
        if token.lower() in text.lower():
            fail(f"legacy token remains in {path}: {token}")
    for status in REMOVED_STATUSES:
        if re.search(rf"\b{re.escape(status)}\b", text):
            fail(f"removed status remains in {path}: {status}")

# Markdown fence balance
for path, text in all_text.items():
    if path.suffix != ".md":
        continue
    backtick = sum(1 for line in text.splitlines() if line.startswith("```"))
    tilde = sum(1 for line in text.splitlines() if line.startswith("~~~"))
    if backtick % 2:
        fail(f"unbalanced backtick fences in {path}")
    if tilde % 2:
        fail(f"unbalanced tilde fences in {path}")

# File Purpose Headers in internal skill reference/template/example/eval docs
for folder in SKILL_RESOURCE_FOLDERS:
    for path in folder.glob("*.md"):
        text = read_text(path)
        if not text.startswith("# File Purpose Header\n\n```yaml\n"):
            fail(f"missing File Purpose Header: {path}")

HEADER_FIELDS = [
    "purpose",
    "status",
    "read_when",
    "do_not_read_when",
    "contains",
    "owner",
    "update_policy",
]
HEADER_STATUSES = {"draft", "ready", "blocked", "done", "closed", "not_applicable"}
for folder in SKILL_RESOURCE_FOLDERS:
    for path in folder.glob("*.md"):
        lines = read_text(path).splitlines()
        fence = lines[2][:3] if len(lines) > 2 else ""
        try:
            closing = lines.index(fence, 3)
        except (IndexError, ValueError):
            fail(f"invalid File Purpose Header fence: {path}")
        fields = [line.split(":", 1)[0] for line in lines[3:closing] if ":" in line]
        if fields != HEADER_FIELDS:
            fail(f"File Purpose Header fields are not normalized: {path}")
        status = lines[4].split(":", 1)[1].strip()
        if status not in HEADER_STATUSES:
            fail(f"invalid File Purpose Header status: {path}")


# Copyable prompts are intentionally header-free user-facing instructions.
PROMPT_ROOT = Path("templates/prompts")
EXPECTED_PROMPTS = {
    "spec-init",
    "spec-resume",
    "spec-planning",
    "spec-close",
    "execution-plan",
    "execution-plan-review",
    "execution-tasks",
    "phase-execute",
    "phase-validate",
    "phase-fix",
    "phase-commit",
    "phase-parallel",
    "execution-close",
}
SPEC_PROMPTS = {"spec-init", "spec-resume", "spec-planning", "spec-close"}
LEGACY_PROMPTS = {"execution-planning", "phase-finalize"}
ALLOWED_PROMPT_PLACEHOLDERS = {
    "SPEC_PATH",
    "EXECUTION_ROOT",
    "PHASE_NUMBER",
    "PARALLEL_PHASES",
    "COMMIT_TYPE",
    "CLOSE_POLICY",
}
REQUIRED_PROMPT_PLACEHOLDERS = {
    "spec-resume": {"SPEC_PATH"},
    "spec-planning": {"SPEC_PATH"},
    "spec-close": {"SPEC_PATH"},
    "execution-plan": {"SPEC_PATH"},
    "execution-plan-review": {"SPEC_PATH"},
    "execution-tasks": {"SPEC_PATH"},
    "phase-execute": {"SPEC_PATH", "PHASE_NUMBER"},
    "phase-validate": {"SPEC_PATH", "PHASE_NUMBER"},
    "phase-fix": {"SPEC_PATH", "PHASE_NUMBER"},
    "phase-commit": {"SPEC_PATH", "PHASE_NUMBER", "COMMIT_TYPE"},
    "phase-parallel": {"PARALLEL_PHASES"},
    "execution-close": {"SPEC_PATH", "CLOSE_POLICY"},
}
PROMPT_METADATA = re.compile(
    r"(?im)^(?:purpose|status|read_when|do_not_read_when|owner|update_policy|contains)\s*:"
)
PROMPT_VENDORS = re.compile(r"\b(?:Claude|Haiku|Sonnet|Codex|Copilot|GPT-\d+|OpenAI|Anthropic)\b", re.IGNORECASE)
PROMPT_CONTRACT_MARKERS = ["# File Purpose Header", "```", "## Core invariants", "## Workflow"]


prompt_files = {path.stem: path for path in PROMPT_ROOT.glob("*.md")}
if set(prompt_files) != EXPECTED_PROMPTS:
    missing = sorted(EXPECTED_PROMPTS - set(prompt_files))
    unexpected = sorted(set(prompt_files) - EXPECTED_PROMPTS)
    fail(f"prompt registry mismatch; missing={missing}, unexpected={unexpected}")
if LEGACY_PROMPTS & set(prompt_files):
    fail(f"legacy prompt remains: {sorted(LEGACY_PROMPTS & set(prompt_files))}")

for name, path in prompt_files.items():
    text = read_text(path)
    if not text.strip():
        fail(f"empty copyable prompt: {path}")
    if not text.startswith("Use `"):
        fail(f"copyable prompt does not begin directly with its instruction: {path}")
    if re.search(r"(?m)^---\s*$", text) or "# File Purpose Header" in text or PROMPT_METADATA.search(text):
        fail(f"copyable prompt retains metadata: {path}")
    if any(marker in text for marker in PROMPT_CONTRACT_MARKERS):
        fail(f"copyable prompt duplicates a contract structure: {path}")
    if "```" in text:
        fail(f"copyable prompt contains a Markdown fence: {path}")

    nonblank_lines = [line for line in text.splitlines() if line.strip()]
    line_limit = 20 if name in {"execution-plan", "execution-plan-review", "phase-parallel"} else 12
    if len(nonblank_lines) > line_limit:
        fail(f"copyable prompt exceeds its compact line budget: {path}")

    expected_skill = "stnl-spec-lifecycle-manager" if name in SPEC_PROMPTS else "stnl-spec-execution-manager"
    other_skill = "stnl-spec-execution-manager" if name in SPEC_PROMPTS else "stnl-spec-lifecycle-manager"
    if expected_skill not in text or other_skill in text:
        fail(f"copyable prompt names the wrong skill: {path}")

    placeholders = set(re.findall(r"\{\{([A-Z0-9_]+)\}\}", text))
    unexpected_placeholders = placeholders - ALLOWED_PROMPT_PLACEHOLDERS
    if unexpected_placeholders:
        fail(f"copyable prompt has unsupported placeholders in {path}: {sorted(unexpected_placeholders)}")
    required_placeholders = REQUIRED_PROMPT_PLACEHOLDERS.get(name, set())
    if not required_placeholders <= placeholders:
        fail(f"copyable prompt lacks required placeholders in {path}: {sorted(required_placeholders - placeholders)}")

    if name == "phase-execute":
        vendorless_text = re.sub(r"\bClaude Code\b", "", text, flags=re.IGNORECASE)
        if PROMPT_VENDORS.search(vendorless_text):
            fail(f"copyable prompt hardcodes a vendor or model: {path}")
        if "Use `/compact` in Claude Code or the environment's equivalent mechanism." not in text:
            fail("phase-execute lacks the compatible context-compaction instruction")
    elif PROMPT_VENDORS.search(text):
        fail(f"copyable prompt hardcodes a vendor or model: {path}")

    for destination in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
        if not re.match(r"(?:https?://|mailto:|#)", destination) and not (path.parent / destination).exists():
            fail(f"copyable prompt has a broken internal link: {path} -> {destination}")

# Skill descriptions, resource completeness, and MODE vocabulary
spec_skill_text = read_text(Path("skills/stnl-spec-lifecycle-manager/SKILL.md"))
frontmatter = spec_skill_text.split("---", 2)
if len(frontmatter) < 3:
    fail("SPEC skill frontmatter is missing")
description_line = next((line for line in frontmatter[1].splitlines() if line.startswith("description:")), "")
if re.search(r"\b(execute|executing|implementation)\b", description_line, re.IGNORECASE):
    fail("SPEC skill frontmatter describes delivery execution")
if re.search(r"\bplan(?:ning)?\b", description_line, re.IGNORECASE):
    fail("SPEC skill frontmatter describes delivery planning")

execution_skill = Path("skills/stnl-spec-execution-manager/SKILL.md")
if not execution_skill.exists():
    fail("execution skill is missing")
execution_skill_text = read_text(execution_skill)
execution_frontmatter = execution_skill_text.split("---", 2)
if len(execution_frontmatter) < 3:
    fail("execution skill frontmatter is missing")
execution_description = next((line for line in execution_frontmatter[1].splitlines() if line.startswith("description:")), "")
if not execution_description:
    fail("execution skill description is missing")
if re.search(r"must use stnl-spec-lifecycle-manager|required stnl-spec-lifecycle-manager|only specs created by", execution_skill_text, re.IGNORECASE):
    fail("execution skill requires stnl-spec-lifecycle-manager")

for path in [
    Path("skills/stnl-spec-execution-manager/references/workspace.md"),
    Path("skills/stnl-spec-execution-manager/references/phase-model.md"),
    Path("skills/stnl-spec-execution-manager/references/phase-execution-contract.md"),
    Path("skills/stnl-spec-execution-manager/references/execution-close-policy.md"),
    Path("skills/stnl-spec-execution-manager/templates/plan-index.template.md"),
    Path("skills/stnl-spec-execution-manager/templates/phase-plan.template.md"),
    Path("skills/stnl-spec-execution-manager/templates/tasks-index.template.md"),
    Path("skills/stnl-spec-execution-manager/templates/phase-tasks.template.md"),
    Path("skills/stnl-spec-execution-manager/examples/phase-driven-workspace.md"),
    Path("skills/stnl-spec-execution-manager/evals/eval-plan.md"),
]:
    if not path.exists():
        fail(f"execution skill resource is missing: {path}")

spec_forbidden = re.compile(
    r"plan\\.md|tasks\\.md|plans/|tasks/|phase-execute|phase-validate|phase-fix|phase-commit|phase-parallel|independent validation|implementation phase",
    re.IGNORECASE,
)
for path in Path("skills/stnl-spec-lifecycle-manager").rglob("*.md"):
    if spec_forbidden.search(read_text(path)):
        fail(f"SPEC skill retains delivery-only content: {path}")

for path, text in all_text.items():
    for match in re.finditer(r"\bMODE\s*[=:]\s*([A-Z_]+)", text):
        mode = match.group(1)
        if mode not in ALLOWED_MODES:
            fail(f"unsupported MODE in {path}: {mode}")

# TOML, JSON, and frontmatter validation
for path in Path("targets/codex/.codex").rglob("*.toml"):
    load_toml(path)
json.loads(read_text(Path("targets/claude-code/.claude/settings.json")))


def parse_frontmatter(path: Path) -> tuple[dict[str, str], str]:
    text = read_text(path)
    lines = text.splitlines()
    if not lines or lines[0] != "---":
        fail(f"invalid frontmatter start: {path}")
    try:
        end = lines.index("---", 1)
    except ValueError:
        fail(f"missing frontmatter end: {path}")
    data: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip() or line.startswith((" ", "\t")):
            fail(f"unsupported or blank frontmatter line in {path}: {line!r}")
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*):\s+(.+)", line)
        if not match:
            fail(f"invalid frontmatter line in {path}: {line!r}")
        key, value = match.groups()
        if key in data:
            fail(f"duplicate frontmatter key in {path}: {key}")
        if value.startswith("[") != value.endswith("]"):
            fail(f"unbalanced frontmatter list in {path}: {key}")
        if key in {"disable-model-invocation", "user-invocable"} and value not in {"true", "false"}:
            fail(f"invalid boolean in {path}: {key}")
        data[key] = value
    return data, "\n".join(lines[end + 1 :])


# Codex target
config = read_text(Path("targets/codex/.codex/config.toml"))
if not re.search(r"^max_depth\s*=\s*2$", config, re.MULTILINE):
    fail("Codex max_depth is not 2")
if re.search(r"^sandbox_mode\s*=", config, re.MULTILINE):
    fail("Codex target mixes sandbox_mode with permission profiles")
for profile in ["sentinel-read-only", "sentinel-workspace"]:
    if f"[permissions.{profile}]" not in config:
        fail(f"missing Codex profile {profile}")
for denied in ["spec.md", "**/spec.md", "specs/**/feature_spec.md", "specs/**/shared/**", "specs/**/slices/**", "specs/**/lifecycle/**"]:
    if denied not in config:
        fail(f"Codex workspace profile does not deny spec writes: {denied}")
codex_agents = {path.stem: load_toml(path) for path in Path("targets/codex/.codex/agents").glob("*.toml")}
expected_codex = {"sentinel-orchestrator", "sentinel-planner", "sentinel-test-planner", "sentinel-coder", "sentinel-validator", "sentinel-reviewer"}
if set(codex_agents) != expected_codex:
    fail(f"Codex agent registry mismatch: {sorted(codex_agents)}")
if codex_agents["sentinel-orchestrator"]["default_permissions"] != "sentinel-read-only":
    fail("Codex orchestrator is not read-only")
if codex_agents["sentinel-reviewer"]["default_permissions"] != "sentinel-read-only":
    fail("Codex reviewer is not read-only")
for name in expected_codex - {"sentinel-orchestrator", "sentinel-reviewer"}:
    if codex_agents[name]["default_permissions"] != "sentinel-workspace":
        fail(f"Codex {name} does not use workspace permissions")
orchestrator_text = codex_agents["sentinel-orchestrator"]["developer_instructions"]
for required in ["read-only textual search", "developer-completion", "Next agent none", "No agent runs after reviewer"]:
    if required not in orchestrator_text:
        fail(f"Codex orchestrator missing rule: {required}")
if re.search(r"\b(source code|whole repository)\b", orchestrator_text) and "must not" not in orchestrator_text.lower():
    fail("Codex orchestrator source-reading restriction is ambiguous")

# Claude Code target
settings = json.loads(read_text(Path("targets/claude-code/.claude/settings.json")))
if settings.get("agent") != "sentinel-orchestrator":
    fail("Claude settings do not select sentinel-orchestrator")
denied = set(settings.get("permissions", {}).get("deny", []))
if not {"Agent(Explore)", "Agent(Plan)", "Agent(general-purpose)"} <= denied:
    fail("Claude settings are missing built-in Agent denials")
claude_dir = Path("targets/claude-code/.claude/agents")
claude_agents = {path.name: parse_frontmatter(path) for path in claude_dir.glob("*.md")}
expected_claude = {f"{name}.md" for name in expected_codex}
if set(claude_agents) != expected_claude:
    fail(f"Claude agent registry mismatch: {sorted(claude_agents)}")
for name, (data, _) in claude_agents.items():
    if not {"name", "description", "tools", "model"} <= data.keys():
        fail(f"Claude frontmatter incomplete: {name}")
expected_tools = "Read, Glob, Grep, Agent(sentinel-planner, sentinel-test-planner, sentinel-coder, sentinel-validator, sentinel-reviewer)"
if claude_agents["sentinel-orchestrator.md"][0]["tools"] != expected_tools:
    fail("Claude orchestrator tools do not match selective search and five-agent delegation")
for forbidden in ["Write", "Edit", "Bash"]:
    if forbidden in claude_agents["sentinel-orchestrator.md"][0]["tools"]:
        fail(f"Claude orchestrator has forbidden tool: {forbidden}")
for name, (data, _) in claude_agents.items():
    if name != "sentinel-orchestrator.md" and re.search(r"(?:^|[, ])Agent(?:\(|[, ]|$)", data["tools"]):
        fail(f"Claude specialist can delegate: {name}")

# Copilot target
copilot_dir = Path("targets/copilot/.github/agents")
copilot_agents = {path.name: parse_frontmatter(path) for path in copilot_dir.glob("*.agent.md")}
expected_copilot = {f"{name}.agent.md" for name in expected_codex}
if set(copilot_agents) != expected_copilot:
    fail(f"Copilot agent registry mismatch: {sorted(copilot_agents)}")
orchestrator_name = "sentinel-orchestrator.agent.md"
invocable = [name for name, (data, _) in copilot_agents.items() if data["user-invocable"] == "true"]
if invocable != [orchestrator_name]:
    fail(f"Copilot user-invocable agents must contain only the orchestrator: {invocable}")
orchestrator_data, orchestrator_body = copilot_agents[orchestrator_name]
orchestrator_tools = {item.strip().lower() for item in orchestrator_data["tools"].strip("[]").split(",")}
if orchestrator_tools != {"read", "search", "agent"}:
    fail(f"Copilot orchestrator tools are wrong: {orchestrator_tools}")
if {"edit", "execute"} & orchestrator_tools:
    fail("Copilot orchestrator has write or execution tools")
if "developer-completion" not in orchestrator_body or "Next agent: none" not in orchestrator_body:
    fail("Copilot orchestrator lacks developer completion return")
negative_prefix = re.compile(r"\b(?:do not|does not|must not|never|cannot|may not)\b", re.IGNORECASE)
delegation = re.compile(r"\b(?:invoke|delegate|call)\b.{0,80}\b(?:agent|sentinel-[a-z-]+)\b", re.IGNORECASE)
direct_call = re.compile(r"\b(?:user|developer)\b.{0,80}\b(?:invoke|call)\b|\b(?:invoke|call)\b.{0,40}\bdirectly\b", re.IGNORECASE)
for name, (data, body) in copilot_agents.items():
    if name == orchestrator_name:
        continue
    if data["user-invocable"] != "false":
        fail(f"Copilot specialist is user-invocable: {name}")
    if data["disable-model-invocation"] != "false":
        fail(f"Copilot specialist cannot be invoked programmatically: {name}")
    tools = {item.strip().lower() for item in data["tools"].strip("[]").split(",")}
    if "agent" in tools:
        fail(f"Copilot specialist has the agent tool: {name}")
    for line in body.splitlines():
        if (delegation.search(line) or direct_call.search(line)) and not negative_prefix.search(line):
            fail(f"Copilot specialist contains delegation/direct-call instruction: {name}: {line}")

# Workflow, ownership, statuses, and reviewer payload consistency
for path in [Path("targets/codex/AGENTS.md"), Path("targets/claude-code/CLAUDE.md"), Path("targets/copilot/AGENTS.md")]:
    text = read_text(path)
    for required in [
        "developer completion",
        "No execution agent may modify",
        "Developer Completion Protocol",
        "spec-state atomicity",
        "not a filesystem transaction",
        "slice context package",
    ]:
        if required not in text:
            fail(f"{path} missing contract text: {required}")
for path in [Path("agents/base/reviewer.md"), Path("targets/codex/.codex/agents/sentinel-reviewer.toml"), Path("targets/claude-code/.claude/agents/sentinel-reviewer.md"), Path("targets/copilot/.github/agents/sentinel-reviewer.agent.md")]:
    text = read_text(path)
    for required in ["satisfied acceptance criteria", "Validator status", "Reviewer status", "mandatory evidence", "DoD", "accepted risks", "changed paths"]:
        if required not in text:
            fail(f"reviewer payload incomplete in {path}: {required}")
for path, text in all_text.items():
    for status in re.findall(r"\b(PASS|BLOCKED|NEEDS_APPROVAL|NEEDS_FIX|NEEDS_REPLAN|NEEDS_RETEST_PLAN|NEEDS_[A-Z_]+)\b", text):
        if status.startswith("NEEDS_") and status not in ALLOWED_HANDOFF:
            fail(f"unsupported handoff status in {path}: {status}")

print("PASS: static target and contract checks")
PY

bash scripts/smoke-structure.sh

echo "PASS: target alignment checks"
