#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
PROMPT_ROOT="${PROMPT_ROOT:-templates/prompts}"
export PROMPT_ROOT
LEGACY_TEMPLATE_NAME="prom""tps"
LEGACY_TEMPLATE_DIR="templates/$LEGACY_TEMPLATE_NAME"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cd "$ROOT"

command -v "$PYTHON_BIN" >/dev/null 2>&1 || fail "PYTHON_BIN is unavailable: $PYTHON_BIN"
"$PYTHON_BIN" -m py_compile scripts/validate_spec_lifecycle.py scripts/test-spec-lifecycle.py

# Packaging metadata is ignored by this structural validator.

# Copyable prompts
test -d "$PROMPT_ROOT" || fail "prompt directory is missing: $PROMPT_ROOT"
test ! -e "$LEGACY_TEMPLATE_DIR" || fail "legacy template path remains: $LEGACY_TEMPLATE_DIR"
for name in spec-init spec-resume spec-planning spec-close execution-plan execution-plan-review execution-tasks slice-execute slice-validate slice-apply-findings slice-finalize slice-parallel execution-close; do
  test -f "$PROMPT_ROOT/$name.md" || fail "missing launcher: $PROMPT_ROOT/$name.md"
done
if grep -R -q --exclude-dir=.git "$LEGACY_TEMPLATE_NAME" .; then
  fail "legacy template reference remains"
fi

# Static contract validation
"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import json
import os
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
        if "stnl-spec-execution-manager" in path.parts:
            if read_text(path).count("```yaml") != 1:
                fail(f"execution resource contains YAML beyond the required header: {path}")

# Lifecycle canonical items use only the current Markdown contract.
SPEC_RESOURCE_ROOT = Path("skills/stnl-spec-lifecycle-manager")
CANONICAL_ID_PATTERN = r"(?:AC|D|C|R|Q)-\d{3}"
CANONICAL_HEADING = re.compile(rf"^### ({CANONICAL_ID_PATTERN}) — \S.*$", re.MULTILINE)
OLD_CANONICAL_HEADING = re.compile(rf"^### ({CANONICAL_ID_PATTERN}) - \S.*$", re.MULTILINE)
for path in SPEC_RESOURCE_ROOT.rglob("*.md"):
    text = read_text(path)
    if OLD_CANONICAL_HEADING.search(text):
        fail(f"lifecycle resource retains a non-canonical item heading: {path}")
    item_starts = list(CANONICAL_HEADING.finditer(text))
    h3_starts = list(re.finditer(r"^### \S.*$", text, re.MULTILINE))
    h2_starts = list(re.finditer(r"^## \S.*$", text, re.MULTILINE))
    for item_start in item_starts:
        candidates = [match.start() for match in h3_starts + h2_starts if match.start() > item_start.start()]
        end = min(candidates) if candidates else len(text)
        item = text[item_start.start():end]
        if re.search(r"(?m)^```(?:yaml|yml|markdown)\s*$", item, re.IGNORECASE):
            fail(f"canonical item is wrapped in YAML/Markdown fence: {path}: {item_start.group(1)}")
        if re.search(rf"(?m)^\s*-?\s*id:\s*{re.escape(item_start.group(1))}\s*$", item):
            fail(f"canonical item repeats its heading ID: {path}: {item_start.group(1)}")
        if re.search(r"(?m)^- [a-z_]+: null$", item, re.IGNORECASE):
            fail(f"canonical item retains optional null metadata: {path}: {item_start.group(1)}")

removed_lifecycle_tokens = [
    "Linked Records",
    "open_question_count",
    "materialized:",
    "created_from_mode",
    "last_updated_mode",
    "workspace_root:",
    "spec_status:",
    "statement:",
    "why_it_matters:",
]
for path in SPEC_RESOURCE_ROOT.rglob("*.md"):
    text = read_text(path)
    for token in removed_lifecycle_tokens:
        if token in text:
            fail(f"removed lifecycle token remains in {path}: {token}")

cases_path = SPEC_RESOURCE_ROOT / "evals/cases.json"
if not cases_path.exists():
    fail("executable lifecycle eval catalog is missing")
cases = json.loads(read_text(cases_path))
if len(cases) < 15 or any("expected_valid" not in case or "assertions" not in case for case in cases):
    fail("executable lifecycle eval catalog is incomplete")
for script in [Path("scripts/validate_spec_lifecycle.py"), Path("scripts/test-spec-lifecycle.py")]:
    if not script.exists():
        fail(f"lifecycle validation script is missing: {script}")


# Copyable prompts are intentionally header-free user-facing instructions.
PROMPT_ROOT = Path(os.environ.get("PROMPT_ROOT", "templates/prompts"))
EXPECTED_PROMPTS = {
    "spec-init",
    "spec-resume",
    "spec-planning",
    "spec-close",
    "execution-plan",
    "execution-plan-review",
    "execution-tasks",
    "slice-execute",
    "slice-validate",
    "slice-apply-findings",
    "slice-finalize",
    "slice-parallel",
    "execution-close",
}
SPEC_PROMPTS = {"spec-init", "spec-resume", "spec-planning", "spec-close"}
PROMPT_MODES = {
    "spec-init": "INIT",
    "spec-resume": "RESUME",
    "spec-planning": "PLANNING",
    "spec-close": "CLOSE",
}
PROMPT_OPERATIONS = {
    "execution-plan": "PLAN",
    "execution-plan-review": "REVIEW_PLAN",
    "execution-tasks": "MATERIALIZE_TASKS",
    "slice-execute": "EXECUTE_SLICE",
    "slice-validate": "VALIDATE_SLICE",
    "slice-apply-findings": "APPLY_FINDINGS",
    "slice-finalize": "FINALIZE_SLICE",
    "slice-parallel": "PARALLELIZE_SLICES",
    "execution-close": "CLOSE",
}
SLICE_PROMPTS = {"slice-execute", "slice-validate", "slice-apply-findings", "slice-finalize"}
LEGACY_PROMPTS = {
    "execution-planning",
    "phase-execute",
    "phase-validate",
    "phase-apply-findings",
    "phase-finalize",
    "phase-commit",
    "phase-parallel",
}
CONTEXT_TITLE = "Contexto adicional (opcional):"
LAUNCHER_LINES = {
    "spec-init": ["Use `stnl-spec-lifecycle-manager`.", "MODE=INIT", "SPEC_PATH={{SPEC_PATH}}", "REQUIREMENTS_SOURCE={{REQUIREMENTS_SOURCE}}", "", CONTEXT_TITLE],
    "spec-resume": ["Use `stnl-spec-lifecycle-manager`.", "MODE=RESUME", "SPEC_PATH={{SPEC_PATH}}", "NEW_INFORMATION={{NEW_INFORMATION}}", "", CONTEXT_TITLE],
    "spec-planning": ["Use `stnl-spec-lifecycle-manager`.", "MODE=PLANNING", "SPEC_PATH={{SPEC_PATH}}", "", CONTEXT_TITLE],
    "spec-close": ["Use `stnl-spec-lifecycle-manager`.", "MODE=CLOSE", "SPEC_PATH={{SPEC_PATH}}", "", CONTEXT_TITLE],
    "execution-plan": ["Use `stnl-spec-execution-manager`.", "OPERATION=PLAN", "SPEC_PATH={{SPEC_PATH}}", "", CONTEXT_TITLE],
    "execution-plan-review": ["Use `stnl-spec-execution-manager`.", "OPERATION=REVIEW_PLAN", "SPEC_PATH={{SPEC_PATH}}", "", CONTEXT_TITLE],
    "execution-tasks": ["Use `stnl-spec-execution-manager`.", "OPERATION=MATERIALIZE_TASKS", "SPEC_PATH={{SPEC_PATH}}", "", CONTEXT_TITLE],
    "slice-execute": ["Use `stnl-spec-execution-manager`.", "OPERATION=EXECUTE_SLICE", "SPEC_PATH={{SPEC_PATH}}", "SLICE={{SLICE}}", "", CONTEXT_TITLE],
    "slice-validate": ["Use `stnl-spec-execution-manager`.", "OPERATION=VALIDATE_SLICE", "SPEC_PATH={{SPEC_PATH}}", "SLICE={{SLICE}}", "", CONTEXT_TITLE],
    "slice-apply-findings": ["Use `stnl-spec-execution-manager`.", "OPERATION=APPLY_FINDINGS", "SPEC_PATH={{SPEC_PATH}}", "SLICE={{SLICE}}", "", CONTEXT_TITLE],
    "slice-finalize": ["Use `stnl-spec-execution-manager`.", "OPERATION=FINALIZE_SLICE", "SPEC_PATH={{SPEC_PATH}}", "SLICE={{SLICE}}", "", CONTEXT_TITLE],
    "slice-parallel": ["Use `stnl-spec-execution-manager`.", "OPERATION=PARALLELIZE_SLICES", "SPEC_PATH={{SPEC_PATH}}", "SLICES={{SLICES}}", "", CONTEXT_TITLE],
    "execution-close": ["Use `stnl-spec-execution-manager`.", "OPERATION=CLOSE", "SPEC_PATH={{SPEC_PATH}}", "", CONTEXT_TITLE],
}


def normalize_final_newline(text: str) -> str:
    if text.endswith("\r\n"):
        return text[:-2]
    if text.endswith("\n"):
        return text[:-1]
    return text


prompt_files = {path.stem: path for path in PROMPT_ROOT.glob("*.md")}
if set(prompt_files) != EXPECTED_PROMPTS:
    missing = sorted(EXPECTED_PROMPTS - set(prompt_files))
    unexpected = sorted(set(prompt_files) - EXPECTED_PROMPTS)
    fail(f"prompt registry mismatch; missing={missing}, unexpected={unexpected}")
if LEGACY_PROMPTS & set(prompt_files):
    fail(f"legacy prompt remains: {sorted(LEGACY_PROMPTS & set(prompt_files))}")

for name, path in prompt_files.items():
    text = path.read_bytes().decode("utf-8")
    expected = "\n".join(LAUNCHER_LINES[name])
    if normalize_final_newline(text) != expected:
        fail(f"launcher is not canonical: {path}")

execution_operations = set(
    re.findall(r"(?m)^### ([A-Z_]+)$", read_text(Path("skills/stnl-spec-execution-manager/SKILL.md")))
)
missing_operations = sorted(set(PROMPT_OPERATIONS.values()) - execution_operations)
if missing_operations:
    fail(f"prompt declares operation missing from execution skill: {missing_operations}")

HELPER_NAMES = {
    "spec-init.md", "spec-resume.md", "spec-planning.md", "spec-close.md",
    "execution-plan.md", "execution-plan-review.md", "execution-tasks.md",
    "slice-execute.md", "slice-validate.md", "slice-apply-findings.md", "slice-finalize.md",
    "slice-parallel.md", "execution-close.md",
}
for skill_root in [Path("skills/stnl-spec-lifecycle-manager"), Path("skills/stnl-spec-execution-manager")]:
    for path in skill_root.rglob("*"):
        if not path.is_file():
            continue
        text = read_text(path)
        if "templates/prompts/" in text or any(name in text for name in HELPER_NAMES):
            fail(f"skill knows a prompt helper: {path}")

INIT_PRECONDITION = "For `INIT`, `SPEC_PATH` must designate a directory path that does not exist. Block an existing file or directory, including a directory without `feature_spec.md`; if `feature_spec.md` already exists, direct the caller to `RESUME`."
for path in [
    Path("skills/stnl-spec-lifecycle-manager/SKILL.md"),
    Path("skills/stnl-spec-lifecycle-manager/references/spec-workspace.md"),
    Path("skills/stnl-spec-lifecycle-manager/references/modes.md"),
    Path("skills/stnl-spec-lifecycle-manager/evals/eval-cases.md"),
    Path("skills/stnl-spec-lifecycle-manager/references/eval-guidance.md"),
]:
    if INIT_PRECONDITION not in read_text(path):
        fail(f"lifecycle INIT precondition is not canonical: {path}")

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
for marker in ["if NEEDS_FIX: APPLY_FINDINGS", "VALIDATE_SLICE as revalidation", "without overwriting the initial validation history"]:
    if marker not in execution_skill_text:
        fail(f"execution workflow does not preserve revalidation: {marker}")

for path in [
    Path("skills/stnl-spec-execution-manager/references/workspace.md"),
    Path("skills/stnl-spec-execution-manager/references/slice-model.md"),
    Path("skills/stnl-spec-execution-manager/references/slice-execution-contract.md"),
    Path("skills/stnl-spec-execution-manager/references/execution-close-policy.md"),
    Path("skills/stnl-spec-execution-manager/templates/plan.template.md"),
    Path("skills/stnl-spec-execution-manager/templates/slice-plan.template.md"),
    Path("skills/stnl-spec-execution-manager/templates/tasks.template.md"),
    Path("skills/stnl-spec-execution-manager/templates/slice-tasks.template.md"),
    Path("skills/stnl-spec-execution-manager/examples/slice-workspace.md"),
    Path("skills/stnl-spec-execution-manager/examples/validation-and-parallelization.md"),
    Path("skills/stnl-spec-execution-manager/evals/eval-plan.md"),
]:
    if not path.exists():
        fail(f"execution skill resource is missing: {path}")

spec_forbidden = re.compile(
    r"plan\\.md|tasks\\.md|plans/|tasks/|slice-execute|slice-validate|slice-parallel|independent validation|implementation slice",
    re.IGNORECASE,
)
for path in Path("skills/stnl-spec-lifecycle-manager").rglob("*.md"):
    if spec_forbidden.search(read_text(path)):
        fail(f"SPEC skill retains delivery-only content: {path}")

for path, text in all_text.items():
    removed_tokens = [
        "CLOSE" + "_POLICY",
        "COMMIT" + "_SLICE",
        "slice-" + "commit",
        "commit" + "_hash",
    ]
    for token in removed_tokens:
        if token in text:
            fail(f"removed execution contract token remains in {path}: {token}")
    for match in re.finditer(r"\bMODE\s*[=:]\s*([A-Z_]+)", text):
        mode = match.group(1)
        if mode not in ALLOWED_MODES:
            fail(f"unsupported MODE in {path}: {mode}")
    for match in re.finditer(r"\bOPERATION\s*[=:]\s*([A-Z_]+)", text):
        operation = match.group(1)
        if operation not in execution_operations:
            fail(f"unsupported OPERATION in {path}: {operation}")

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
