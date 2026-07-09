#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
cd "$ROOT"

"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import re
import tempfile
from pathlib import Path


FIELDS = ["purpose", "status", "read_when", "do_not_read_when", "contains", "owner", "update_policy"]
STATUSES = {"draft", "ready", "blocked", "done", "closed", "not_applicable"}
SPEC_ROOT = Path("skills/stnl-spec-lifecycle-manager")
EXEC_ROOT = Path("skills/stnl-spec-execution-manager")


def fail(message: str) -> None:
    raise SystemExit(message)


def expect(value: bool, message: str) -> None:
    if not value:
        fail(message)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def header(owner: str, purpose: str, status: str = "ready") -> str:
    return f"""# File Purpose Header

```yaml
purpose: {purpose}
status: {status}
read_when: Needed for structural smoke validation.
do_not_read_when: A narrower artifact is enough.
contains: Smoke fixture content.
owner: {owner}
update_policy: Test fixture only.
```

"""


def check_header(path: Path, owner: str | None = None) -> None:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"# File Purpose Header\n\n```yaml\n(.*?)```\n", text, re.DOTALL)
    expect(match is not None, f"missing normalized header: {path}")
    lines = [line for line in match.group(1).splitlines() if ":" in line]
    keys = [line.split(":", 1)[0] for line in lines]
    expect(keys == FIELDS, f"wrong header fields: {path}")
    values = {line.split(":", 1)[0]: line.split(":", 1)[1].strip() for line in lines}
    expect(values["status"] in STATUSES, f"invalid header status: {path}")
    expect("load_when" not in values and "do_not_load_when" not in values, f"legacy header fields: {path}")
    if owner:
        expect(values["owner"] == owner, f"wrong header owner: {path}")


def canonical_ids(text: str) -> set[str]:
    return set(re.findall(r"\b(?:Q|D|AC|R|C)-\d{3}\b", text))


def spec_fixture(root: Path) -> None:
    write(root / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Fixture feature SPEC") + """# Fixture Feature SPEC

## Objective

Deliver the fixture behavior.

## Scope

- Include the observable fixture behavior.

## Canonical Artifact Index

```yaml
artifacts:
  acceptance_criteria: {file: shared/acceptance-criteria.md, count: 1, materialized: true}
  decisions: {file: shared/decisions.md, count: 1, materialized: true}
```

## Linked Records

AC-001, D-001

## Selective Reading

Read this file, then only the linked canonical records.
""")
    write(root / "shared/acceptance-criteria.md", header("stnl-spec-lifecycle-manager", "Fixture acceptance criteria") + """# Acceptance Criteria

### AC-001 - Observable behavior

```yaml
id: AC-001
status: active
statement: The fixture behavior can be observed.
```
""")
    write(root / "shared/decisions.md", header("stnl-spec-lifecycle-manager", "Fixture decisions") + """# Decisions

### D-001 - Fixture boundary

```yaml
id: D-001
status: accepted
decision: Keep the fixture local.
```
""")


def check_ids(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    headings = set(re.findall(r"^### ((?:Q|D|AC|R|C)-\d{3})\b", text, re.MULTILINE))
    fields = set(re.findall(r"^id:\s*((?:Q|D|AC|R|C)-\d{3})$", text, re.MULTILINE))
    expect(headings == fields, f"heading/id mismatch: {path}")
    expect(len(re.findall(r"^id:\s*(?:Q|D|AC|R|C)-\d{3}$", text, re.MULTILINE)) == len(fields), f"duplicate canonical id: {path}")
    return headings


def check_spec_active(root: Path) -> None:
    feature = root / "feature_spec.md"
    expect(feature.exists(), "SPEC workspace missing feature_spec.md")
    check_header(feature, "stnl-spec-lifecycle-manager")
    forbidden = ["plan.md", "tasks.md", "plans", "tasks"]
    for name in forbidden:
        expect(not (root / name).exists(), f"SPEC workspace contains delivery artifact: {name}")
    expect((root / "shared/acceptance-criteria.md").exists(), "SPEC workspace missing materialized ACs")
    available: set[str] = set()
    for path in (root / "shared").glob("*.md"):
        check_header(path, "stnl-spec-lifecycle-manager")
        available |= check_ids(path)
    feature_text = feature.read_text(encoding="utf-8")
    expect({"AC-001", "D-001"} <= available, "SPEC fixture lacks canonical records")
    expect({"AC-001", "D-001"} <= canonical_ids(feature_text), "SPEC references are missing")
    expect("Selective Reading" in feature_text, "SPEC feature document lacks selective reading")


def check_spec_blocked(root: Path) -> None:
    for path in [root / "feature_spec.md", root / "shared/questions.md"]:
        expect(path.exists(), f"blocked SPEC missing file: {path}")
        check_header(path, "stnl-spec-lifecycle-manager")
    questions = (root / "shared/questions.md").read_text(encoding="utf-8")
    expect("Q-001" in questions and "status: open" in questions, "blocked question is malformed")
    for name in ["plan.md", "tasks.md", "plans", "tasks"]:
        expect(not (root / name).exists(), f"blocked SPEC contains delivery artifact: {name}")


def check_spec_closed(root: Path) -> None:
    expected = {root / "feature_spec.md"}
    actual = {path for path in root.rglob("*") if path.is_file()}
    expect(actual == expected, "closed SPEC has auxiliary residue")
    check_header(root / "feature_spec.md", "stnl-spec-lifecycle-manager")


def execution_fixture(root: Path) -> None:
    write(root / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Fixture requirements source") + """# Fixture Requirements

### AC-001 - Observable behavior

```yaml
id: AC-001
status: active
statement: The behavior is observable.
```
""")
    write(root / "plan.md", header("stnl-spec-execution-manager", "Fixture delivery plan index") + """# Delivery Plan Index

## Requirements Source

```yaml
requirements_source: feature_spec.md
execution_workspace: fixture
```

| Done | Phase | Objective | Dependencies | Covered IDs or criteria | Parallel | Detail | Result |
|---|---|---|---|---|---|---|---|
| [ ] | 01 - Fixture | Deliver behavior | - | AC-001 | no | plans/plan-01.md | - |
""")
    write(root / "plans/plan-01.md", header("stnl-spec-execution-manager", "Fixture detailed plan") + """# Phase 01 - Fixture

## Source and Phase Metadata

```yaml
phase: 01
requirements_source: feature_spec.md
parallelizable: false
parallel_safety: not_applicable
```

## Requirements References

AC-001
""")
    write(root / "tasks.md", header("stnl-spec-execution-manager", "Fixture delivery tasks index") + """# Delivery Tasks Index

| Done | Phase | Tasks | Detail | Tests | Validation | Result |
|---|---|---|---|---|---|---|
| [ ] | 01 - Fixture | 1 task | tasks/tasks-01.md | pending | pending | - |
""")
    write(root / "tasks/tasks-01.md", header("stnl-spec-execution-manager", "Fixture detailed task record") + """# Phase 01 Tasks - Fixture

## Source and Phase Metadata

```yaml
phase: 01
requirements_source: feature_spec.md
plan: plans/plan-01.md
covered_references: [AC-001]
```

## Checklist

- [ ] 1.1 Deliver behavior — areas: fixture — acceptance: AC-001

## Execution Evidence

```yaml
tests_executed: []
test_result: pending
validation: pending
revalidation: pending
```
""")


def check_execution(root: Path) -> None:
    files = [root / "feature_spec.md", root / "plan.md", root / "plans/plan-01.md", root / "tasks.md", root / "tasks/tasks-01.md"]
    for path in files:
        expect(path.exists(), f"delivery workspace missing file: {path}")
    check_header(root / "feature_spec.md", "stnl-spec-lifecycle-manager")
    for path in files[1:]:
        check_header(path, "stnl-spec-execution-manager")

    plan_index = (root / "plan.md").read_text(encoding="utf-8")
    tasks_index = (root / "tasks.md").read_text(encoding="utf-8")
    plan = (root / "plans/plan-01.md").read_text(encoding="utf-8")
    tasks = (root / "tasks/tasks-01.md").read_text(encoding="utf-8")
    source = (root / "feature_spec.md").read_text(encoding="utf-8")

    expect("requirements_source: feature_spec.md" in plan_index and "requirements_source: feature_spec.md" in plan, "delivery source path is missing")
    expect("plans/plan-01.md" in plan_index, "plan index link is missing")
    expect("tasks/tasks-01.md" in tasks_index, "tasks index link is missing")
    expect("plan: plans/plan-01.md" in tasks, "task record points to the wrong plan")
    expect(re.search(r"^# Phase 01\b", plan, re.MULTILINE) is not None, "plan number mismatch")
    expect(re.search(r"^# Phase 01 Tasks\b", tasks, re.MULTILINE) is not None, "tasks number mismatch")
    expect(re.search(r"^phase:\s*01$", plan, re.MULTILINE) is not None, "plan metadata mismatch")
    expect(re.search(r"^phase:\s*01$", tasks, re.MULTILINE) is not None, "task metadata mismatch")
    expect(canonical_ids(plan + tasks) <= canonical_ids(source), "delivery references a missing criterion")

    plan_done = "| [x] | 01" in plan_index
    tasks_done = "| [x] | 01" in tasks_index
    expect(plan_done == tasks_done, "delivery indices disagree")
    if plan_done:
        expect("- [ ]" not in tasks, "concluded phase has an open task")
        expect("test_result: PASS" in tasks, "concluded phase lacks successful test evidence")
        expect("validation: PASS" in tasks, "concluded phase lacks validation evidence")
        expect("revalidation: PASS" in tasks or "revalidation: not_required" in tasks, "concluded phase lacks revalidation evidence")

    if "| yes | plans/plan-01.md" in plan_index:
        expect("parallel_safety: verified" in plan, "parallel phase lacks verified non-overlap")


def invalid_execution(name: str, mutate) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / name
        execution_fixture(root)
        mutate(root)
        try:
            check_execution(root)
        except SystemExit:
            return
        fail(f"invalid delivery fixture accepted: {name}")


def static_contract_checks() -> None:
    for root, owner in [(SPEC_ROOT, "stnl-spec-lifecycle-manager"), (EXEC_ROOT, "stnl-spec-execution-manager")]:
        for folder in ["references", "templates", "examples", "evals"]:
            for path in (root / folder).glob("*.md"):
                check_header(path, owner)
    spec_forbidden = re.compile(r"plan\\.md|tasks\\.md|plans/|tasks/|phase-execute|phase-validate|phase-fix|phase-commit|phase-parallel|independent validation|implementation phase", re.IGNORECASE)
    for path in SPEC_ROOT.rglob("*.md"):
        expect(spec_forbidden.search(path.read_text(encoding="utf-8")) is None, f"SPEC skill retains delivery content: {path}")

    execution_text = "\n".join(path.read_text(encoding="utf-8") for path in EXEC_ROOT.rglob("*.md"))
    expect("must use stnl-spec-lifecycle-manager" not in execution_text.lower(), "delivery skill requires SPEC skill")
    expect("required stnl-spec-lifecycle-manager" not in execution_text.lower(), "delivery skill requires SPEC skill")
    expect("only specs created by" not in execution_text.lower(), "delivery skill requires one source")
    close_policy = (EXEC_ROOT / "references/execution-close-policy.md").read_text(encoding="utf-8")
    for policy in ["validate_only", "consolidate_and_keep", "consolidate_and_remove"]:
        expect(policy in close_policy, f"missing operational closure policy: {policy}")


with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)

    active_spec = base / "active-spec"
    spec_fixture(active_spec)
    check_spec_active(active_spec)

    blocked_spec = base / "blocked-spec"
    write(blocked_spec / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Blocked feature SPEC", "blocked") + "# Blocked SPEC\n")
    write(blocked_spec / "shared/questions.md", header("stnl-spec-lifecycle-manager", "Blocking questions", "blocked") + "### Q-001 - Scope\n\n```yaml\nid: Q-001\nstatus: open\n```\n")
    check_spec_blocked(blocked_spec)

    closed_spec = base / "closed-spec"
    write(closed_spec / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Closed feature SPEC", "closed") + "# Closed SPEC\n")
    check_spec_closed(closed_spec)

    active_execution = base / "active-execution"
    execution_fixture(active_execution)
    check_execution(active_execution)

    invalid_execution("missing-plan", lambda root: (root / "plans/plan-01.md").unlink())
    invalid_execution("wrong-task-plan", lambda root: (root / "tasks/tasks-01.md").write_text((root / "tasks/tasks-01.md").read_text(encoding="utf-8").replace("plans/plan-01.md", "plans/plan-02.md"), encoding="utf-8"))
    invalid_execution("missing-ac", lambda root: (root / "tasks/tasks-01.md").write_text((root / "tasks/tasks-01.md").read_text(encoding="utf-8").replace("AC-001", "AC-999"), encoding="utf-8"))
    invalid_execution("completed-open-task", lambda root: ((root / "plan.md").write_text((root / "plan.md").read_text(encoding="utf-8").replace("| [ ] | 01", "| [x] | 01"), encoding="utf-8"), (root / "tasks.md").write_text((root / "tasks.md").read_text(encoding="utf-8").replace("| [ ] | 01", "| [x] | 01"), encoding="utf-8")))
    invalid_execution("parallel-without-safety", lambda root: (root / "plan.md").write_text((root / "plan.md").read_text(encoding="utf-8").replace("| no | plans/plan-01.md", "| yes | plans/plan-01.md"), encoding="utf-8"))

    static_contract_checks()

print("PASS: SPEC workspace structural smoke validation")
print("PASS: delivery workspace structural smoke validation")
PY
