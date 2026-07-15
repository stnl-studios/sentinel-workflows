#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
PROMPT_ROOT="${PROMPT_ROOT:-templates/prompts}"
SUBAGENT_TEMPLATE_ROOT="${SUBAGENT_TEMPLATE_ROOT:-templates/subagents}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cd "$ROOT"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || fail "PYTHON_BIN is unavailable: $PYTHON_BIN"
"$PYTHON_BIN" -m py_compile scripts/check-contracts.py scripts/validate_spec_lifecycle.py scripts/test-spec-lifecycle.py scripts/test-serial-workflow.py
"$PYTHON_BIN" scripts/check-contracts.py launchers --root "$PROMPT_ROOT"
"$PYTHON_BIN" scripts/check-contracts.py validation-runner --root "$SUBAGENT_TEMPLATE_ROOT"

"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import json
import re
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    tomllib = None


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        fail(f"missing file: {path}")


def load_toml(path: Path) -> dict:
    text = read(path)
    if tomllib is not None:
        return tomllib.loads(text)
    data: dict = {}
    section: list[str] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        raw = lines[index]
        index += 1
        line = raw.strip()
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
        key, value = (part.strip() for part in line.split("=", 1))
        if value.startswith('\"\"\"'):
            collected = [value[3:]]
            while not collected[-1].endswith('\"\"\"'):
                if index >= len(lines):
                    fail(f"unterminated TOML string in {path}: {key}")
                collected.append(lines[index])
                index += 1
            collected[-1] = collected[-1][:-3]
            parsed: object = "\n".join(collected)
        elif value.startswith('"') and value.endswith('"'):
            parsed = value[1:-1]
        elif value.isdigit():
            parsed = int(value)
        else:
            fail(f"unsupported TOML value in {path}: {raw!r}")
        cursor = data
        for part in section:
            cursor = cursor.setdefault(part, {})
        cursor[key] = parsed
    return data


def parse_frontmatter(path: Path) -> tuple[dict[str, str], str]:
    lines = read(path).splitlines()
    if not lines or lines[0] != "---":
        fail(f"frontmatter start is missing: {path}")
    try:
        end = lines.index("---", 1)
    except ValueError:
        fail(f"frontmatter end is missing: {path}")
    data: dict[str, str] = {}
    for line in lines[1:end]:
        match = re.fullmatch(r"([A-Za-z][A-Za-z0-9-]*):\s+(.+)", line)
        if not match:
            fail(f"invalid frontmatter line in {path}: {line!r}")
        key, value = match.groups()
        if key in data:
            fail(f"duplicate frontmatter field in {path}: {key}")
        data[key] = value
    return data, "\n".join(lines[end + 1:])


def check_file_header(path: Path, owner: str) -> None:
    text = read(path)
    match = re.match(r"# File Purpose Header\n\n```yaml\n(.*?)```\n", text, re.DOTALL)
    if not match:
        fail(f"missing File Purpose Header: {path}")
    lines = [line for line in match.group(1).splitlines() if line]
    fields = [line.split(":", 1)[0] for line in lines]
    expected = ["purpose", "status", "read_when", "do_not_read_when", "contains", "owner", "update_policy"]
    if fields != expected:
        fail(f"noncanonical File Purpose Header fields: {path}")
    values = dict(line.split(":", 1) for line in lines)
    if values["status"].strip() not in {"draft", "ready", "blocked", "done", "closed", "not_applicable"}:
        fail(f"invalid File Purpose Header status: {path}")
    if values["owner"].strip() != owner:
        fail(f"wrong File Purpose Header owner in {path}")
    if text.count("```yaml") != 1:
        fail(f"execution resource contains extra YAML blocks: {path}")


execution_skills = {
    "stnl-execution-planner": {"PLAN"},
    "stnl-plan-reviewer": {"REVIEW_PLAN"},
    "stnl-task-materializer": {"MATERIALIZE_TASKS"},
    "stnl-task-reviewer": {"REVIEW_TASKS"},
    "stnl-slice-executor": {"EXECUTE_SLICE", "APPLY_FINDINGS"},
    "stnl-slice-quality-manager": {"VALIDATE_SLICE"},
    "stnl-execution-closer": {"CLOSE"},
}

actual_execution = {path.name for path in Path("skills").glob("stnl-*") if (path / "SKILL.md").is_file() and path.name != "stnl-spec-lifecycle-manager"}
if actual_execution != set(execution_skills):
    fail(f"execution skill registry mismatch; expected={sorted(execution_skills)}, actual={sorted(actual_execution)}")

required_sections = ["Purpose", "Inputs", "Authority", "Minimum Reads", "Allowed Effects", "Blocks", "Output"]
for name, operations in execution_skills.items():
    root = Path("skills") / name
    skill = root / "SKILL.md"
    frontmatter, body = parse_frontmatter(skill)
    if frontmatter.get("name") != name or not frontmatter.get("description"):
        fail(f"invalid skill frontmatter: {skill}")
    for section in required_sections:
        if f"## {section}" not in body:
            fail(f"missing {section} section: {skill}")
    declared = {operation for operation in operations if f"## {operation}" in body}
    if declared != operations:
        fail(f"operation declaration mismatch in {skill}: {sorted(declared)}")
    for folder in ["references", "templates", "examples", "evals"]:
        for path in (root / folder).glob("*.md"):
            check_file_header(path, name)

all_execution_text = "\n".join(read(path) for name in execution_skills for path in (Path("skills") / name).rglob("*.md"))
for token in ["stnl-spec-execution-manager", "FINALIZE_SLICE", "PARALLELIZE_SLICES", "SLICES", "slice-finalize", "slice-parallel", "RUN_TESTS", "RETRY_TESTS", "FIX_TESTS", "TEST_SLICE", "TEST_FINDINGS", "VALIDATE_IMPLEMENTATION"]:
    if token in all_execution_text:
        fail(f"removed execution token remains in skills: {token}")
for vendor in ["Claude Code", "@agent-stnl-validation-runner", "stnl_validation_runner", "gpt-", "haiku", "sonnet"]:
    if vendor.lower() in all_execution_text.lower():
        fail(f"execution skills are not vendor-neutral: {vendor}")

planner = read(Path("skills/stnl-execution-planner/SKILL.md"))
reviewer = read(Path("skills/stnl-plan-reviewer/SKILL.md"))
materializer = read(Path("skills/stnl-task-materializer/SKILL.md"))
task_reviewer = read(Path("skills/stnl-task-reviewer/SKILL.md"))
executor = read(Path("skills/stnl-slice-executor/SKILL.md"))
quality = read(Path("skills/stnl-slice-quality-manager/SKILL.md"))
closer = read(Path("skills/stnl-execution-closer/SKILL.md"))
for marker in ["status to `draft`", "`REVIEW_PLAN` is required", "allowed only when the root is absent or contains no other entries", "preserve every byte", "Reset is a separate explicit user action"]:
    if marker not in planner:
        fail(f"planner lacks unapproved-plan contract: {marker}")
for marker in ["status of `plan.md` and every detailed plan to `ready`", "review state to `approved`", "Run only in `planned`", "preserve all plans byte-for-byte"]:
    if marker not in reviewer:
        fail(f"plan reviewer lacks approval contract: {marker}")
for marker in ["File Purpose Header status `ready`", "review state `approved`", "may not alter plans", "Any task artifact", "Validate every precondition and render the full task set before publishing"]:
    if marker not in materializer:
        fail(f"materializer lacks approved-plan boundary: {marker}")
for marker in ["may alter only `tasks.md`", "Return `NEEDS_REPLAN`", "Run only in `materialized-pristine`", "Validation Attempt", "preserve all plans and tasks byte-for-byte"]:
    if marker not in task_reviewer:
        fail(f"task reviewer lacks write boundary: {marker}")
for marker in ["`tasks.md` defines global progress and is read-only", "configured runner at least once and at most three times", "The first invocation is mandatory", "cannot be skipped because the change appears simple", "Once implementation or correction has occurred, the operation cannot end without invoking", "valid auxiliary status is received or the runner fails to start", "Additional invocations occur only after `TESTS_FAIL` in round one or two", "without running verification commands in the main context", "`TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE`, or `BLOCKED`", "Never make a fourth automatic invocation", "use an unbounded loop", "After `TESTS_FAIL` in round one or two", "Persist every valid result append-only", "A later manual invocation has its own three-call budget", "objective discovery and when no verification command was executed", "read-only actions used only to discover applicable checks are permitted", "Implementation Test Evidence", "Findings Test Evidence", "fall back to checks in the main context", "create a Validation Attempt or Effective Validation Base", "mark `[x]`", "Prior Validation Overlap", "Do not reopen or rewrite an earlier slice"]:
    if marker not in executor:
        fail(f"executor lacks completion/runner boundary: {marker}")
for pattern in [r"(?i)\bup to three times\b", r"(?i)\bzero to three calls\b", r"(?i)\bmay invoke the runner\b", r"(?i)\brunner invocation is optional\b", r"(?i)\bskip the runner when no tests apply\b", r"(?i)\bno runner call is required\b"]:
    if re.search(pattern, executor):
        fail(f"executor permits an optional or zero-call runner cycle: {pattern}")
for marker in ["only when it returns `PASS`", "For every valid runner invocation", "append exactly one deterministic next `attempt-NN`", "Prior test evidence is auxiliary", "tested file state is still current", "independently review a prior `TESTS_NOT_APPLICABLE`", "which read-only discovery actions were performed", "which discovery sources were consulted", "which verification types were considered", "whether any applicable verification command was omitted", "absence of a tool or environment was confused with absence of applicability", "executes or repeats checks proportionally", "On `NEEDS_FIX`", "Effective Validation Base unchanged or absent", "keep the global row `[ ]`", "On `BLOCKED`", "do not convert the status", "complete final manifest", "create or replace the entire Effective Validation Base", "origin is `NEEDS_FIX` or `BLOCKED`", "change exactly the selected global row"]:
    if marker not in quality:
        fail(f"quality manager lacks verdict persistence contract: {marker}")
for marker in ["final validation ownership", "walking completed slices once in the exact serial order", "Earlier hashes remain historical and are never compared", "compare each path only with its last owner", "no final validation owner", "Do not inspect hashes stored inside Validation Attempts", "Do not run tests", "Do not edit, test, invoke a runner"]:
    if marker not in closer:
        fail(f"closer lacks drift/no-test contract: {marker}")

for forbidden, text, label in [
    ("create or replace the planning artifacts", planner, "planner replacement"),
    ("create or replace task artifacts", materializer, "materializer replacement"),
    ("Recalculate SHA-256 for every path in each validation base", closer, "historical base drift"),
    ("FINALIZE_SLICE", all_execution_text, "removed finalizer"),
    ("PARALLELIZE_SLICES", all_execution_text, "parallel execution"),
]:
    if forbidden in text:
        fail(f"forbidden execution semantics remain: {label}")

task_template = read(Path("skills/stnl-task-materializer/templates/slice-tasks.template.md"))
for marker in ["## Implementation Test Evidence", "### implementation-check-01", "## Findings Test Evidence", "### findings-check-01", "TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED", "Automatic check round", "Check discovery sources", "Non-applicability rationale", "No verification-command confirmation", "Discovery-only read operations are allowed", "Correction applied before this round", "Files altered between rounds", "## Validation Attempts", "### attempt-01", "## Effective Validation Base", "Origin attempt", "Result: PASS", "REMOVED", "Prior Validation Overlap"]:
    if marker not in task_template:
        fail(f"slice task template lacks current validation contract: {marker}")
for legacy in ["## Validation History", "## Validation Base\n"]:
    if legacy in task_template:
        fail(f"slice task template retains legacy validation contract: {legacy.strip()}")

json.loads(read(Path("targets/claude-code/.claude/settings.json")))
load_toml(Path("targets/codex/.codex/config.toml"))
expected_agents = {"sentinel-orchestrator", "sentinel-planner", "sentinel-test-planner", "sentinel-coder", "sentinel-validator", "sentinel-reviewer"}
codex_agents = {path.stem for path in Path("targets/codex/.codex/agents").glob("*.toml")}
claude_agents = {path.stem for path in Path("targets/claude-code/.claude/agents").glob("*.md")}
copilot_agents = {path.name.removesuffix(".agent.md") for path in Path("targets/copilot/.github/agents").glob("*.agent.md")}
if codex_agents != expected_agents or claude_agents != expected_agents or copilot_agents != expected_agents:
    fail("an unrelated target agent registry changed")

lifecycle = Path("skills/stnl-spec-lifecycle-manager")
if not (lifecycle / "SKILL.md").exists() or not (lifecycle / "evals/cases.json").exists():
    fail("lifecycle skill resources are missing")
cases = json.loads(read(lifecycle / "evals/cases.json"))
if len(cases) < 15:
    fail("lifecycle eval catalog is incomplete")

print("PASS: static target, skill, launcher, and validation-runner checks")
PY

if [[ "${SKIP_SMOKE:-0}" != "1" ]]; then
  bash scripts/smoke-structure.sh
fi
echo "PASS: target alignment checks"
