#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
cd "$ROOT"

"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import hashlib
import re
import tempfile
from pathlib import Path


FIELDS = ["purpose", "status", "read_when", "do_not_read_when", "contains", "owner", "update_policy"]
STATUSES = {"draft", "ready", "blocked", "done", "closed", "not_applicable"}
SPEC_ROOT = Path("skills/stnl-spec-lifecycle-manager")
EXEC_ROOT = Path("skills/stnl-spec-execution-manager")
LEGACY_PHASE_FIX = "phase-fix"
EVIDENCE_SCALAR_VALUES = {
    "test_result": {"pending", "PASS", "NEEDS_FIX", "not_applicable"},
    "validation": {"pending", "PASS", "NEEDS_FIX"},
    "revalidation": {"pending", "PASS", "NEEDS_FIX", "not_required"},
}
EVIDENCE_SCALARS = set(EVIDENCE_SCALAR_VALUES) | {"test_reason"}
EVIDENCE_LISTS = {"tests_executed", "corrections"}
EVIDENCE_FIELDS = EVIDENCE_SCALARS | EVIDENCE_LISTS
REQUIRED_EVIDENCE_FIELDS = ["tests_executed", "test_result", "validation", "corrections", "revalidation"]
GENERIC_TEST_REASONS = {"none", "n/a", "na", "not applicable", "not_applicable"}


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
    feature = root / "feature_spec.md"
    expect(feature.exists(), "closed SPEC missing feature_spec.md")
    check_header(feature, "stnl-spec-lifecycle-manager")
    expect(not (root / "shared").exists(), "closed SPEC retains lifecycle shared/ residue")


def snapshot_tree(root: Path) -> tuple[tuple[str, str, str], ...]:
    snapshot: list[tuple[str, str, str]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(root).as_posix()
        if path.is_dir():
            snapshot.append(("directory", relative, ""))
        else:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            snapshot.append(("file", relative, digest))
    return tuple(snapshot)


def execution_fixture(root: Path) -> None:
    write(root / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Fixture requirements source") + """# Fixture Requirements

### AC-001 - Observable behavior

```yaml
id: AC-001
status: active
statement: The behavior is observable.
```
""")
    execution = root / "execution"
    write(execution / "plan.md", header("stnl-spec-execution-manager", "Fixture delivery plan index") + """# Delivery Plan Index

## Requirements Source

```yaml
requirements_source: ../feature_spec.md
execution_workspace: .
```

| Done | Phase | Objective | Dependencies | Covered IDs or criteria | Parallel | Detail | Result |
|---|---|---|---|---|---|---|---|
| [ ] | 01 - Fixture | Deliver behavior | - | AC-001 | no | plans/plan-01.md | - |
""")
    write(execution / "plans/plan-01.md", header("stnl-spec-execution-manager", "Fixture detailed plan") + """# Phase 01 - Fixture

## Source and Phase Metadata

```yaml
phase: 01
requirements_source: ../../feature_spec.md
parallelizable: false
parallel_safety: not_applicable
```

## Requirements References

AC-001
""")
    write(execution / "tasks.md", header("stnl-spec-execution-manager", "Fixture delivery tasks index") + """# Delivery Tasks Index

| Done | Phase | Tasks | Detail | Tests | Validation | Result |
|---|---|---|---|---|---|---|
| [ ] | 01 - Fixture | 1 task | tasks/tasks-01.md | pending | pending | - |
""")
    write(execution / "tasks/tasks-01.md", header("stnl-spec-execution-manager", "Fixture detailed task record") + """# Phase 01 Tasks - Fixture

## Source and Phase Metadata

```yaml
phase: 01
requirements_source: ../../feature_spec.md
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
corrections: []
revalidation: pending
```
""")


def extract_evidence_fields(task_path: Path) -> dict[str, str | list[str]]:
    text = task_path.read_text(encoding="utf-8")
    blocks = re.findall(
        r"^## Execution Evidence\n\n```yaml\n(.*?)^```\s*$",
        text,
        re.MULTILINE | re.DOTALL,
    )
    expect(len(blocks) == 1, f"expected exactly one Execution Evidence block: {task_path}")

    fields: dict[str, str | list[str]] = {}
    lines = blocks[0].splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("  - "):
            fail(f"list item without active evidence list: {task_path}")

        match = re.match(r"^([a-z_]+):(.*)$", line)
        expect(match is not None, f"malformed evidence line {line!r}: {task_path}")
        field, raw_value = match.groups()
        expect(field in EVIDENCE_FIELDS, f"unknown evidence field {field}: {task_path}")

        if field in EVIDENCE_SCALARS:
            expect(field not in fields, f"duplicate evidence field {field}: {task_path}")
            value = raw_value.strip()
            if field == "test_reason":
                expect(value, f"empty test_reason: {task_path}")
                expect(value.lower() not in GENERIC_TEST_REASONS, f"generic test_reason value {value!r}: {task_path}")
            else:
                expect(value in EVIDENCE_SCALAR_VALUES[field], f"invalid {field} value {value!r}: {task_path}")
            fields[field] = value
        else:
            expect(field not in fields, f"duplicate evidence field {field}: {task_path}")
            value = raw_value.strip()
            if value == "[]":
                fields[field] = []
            else:
                expect(not value, f"malformed {field} list: {task_path}")
                items: list[str] = []
                index += 1
                while index < len(lines):
                    item_line = lines[index]
                    if item_line.startswith("  -"):
                        expect(item_line.startswith("  - "), f"empty {field} entry: {task_path}")
                        item = item_line[4:].strip()
                        expect(item, f"empty {field} entry: {task_path}")
                        items.append(item)
                        index += 1
                        continue
                    if item_line.startswith(" "):
                        fail(f"malformed {field} list item: {task_path}")
                    break
                expect(items, f"malformed {field} list: {task_path}")
                fields[field] = items
                continue
        index += 1

    for field in REQUIRED_EVIDENCE_FIELDS:
        expect(field in fields, f"missing evidence field {field}: {task_path}")
    if "test_reason" in fields:
        expect(fields["test_result"] == "not_applicable", f"test_reason is only allowed with not_applicable test_result: {task_path}")
    return fields


def render_list_field(field: str, values: list[str]) -> str:
    if not values:
        return f"{field}: []"
    return "\n".join([f"{field}:", *[f"  - {value}" for value in values]])


def validate_concluded_test_evidence(evidence: dict[str, str | list[str]], task_path: Path) -> None:
    tests_executed = evidence["tests_executed"]
    expect(isinstance(tests_executed, list), f"tests_executed is not a list: {task_path}")
    test_result = evidence["test_result"]
    expect(isinstance(test_result, str), f"test_result is not scalar: {task_path}")

    if test_result == "PASS":
        expect(bool(tests_executed), f"PASS test_result requires at least one tests_executed item: {task_path}")
        expect("test_reason" not in evidence, f"test_reason is only allowed with not_applicable test_result: {task_path}")
        return

    if test_result == "not_applicable":
        expect(tests_executed == [], f"not_applicable test_result requires empty tests_executed: {task_path}")
        expect("test_reason" in evidence, f"not_applicable test_result requires test_reason: {task_path}")
        test_reason = evidence["test_reason"]
        expect(isinstance(test_reason, str) and bool(test_reason.strip()), f"not_applicable test_result requires non-empty test_reason: {task_path}")
        return

    fail(f"concluded phase has invalid test_result {test_result!r}: {task_path}")


def write_evidence(
    root: Path,
    *,
    tests_executed: list[str],
    test_result: str,
    test_reason: str | None,
    validation: str,
    corrections: list[str],
    revalidation: str,
) -> None:
    test_reason_line = f"test_reason: {test_reason}\n" if test_reason is not None else ""
    evidence = f"""## Execution Evidence

```yaml
{render_list_field("tests_executed", tests_executed)}
test_result: {test_result}
{test_reason_line}validation: {validation}
{render_list_field("corrections", corrections)}
revalidation: {revalidation}
```
"""
    task_path = root / "execution/tasks/tasks-01.md"
    updated, replacements = re.subn(
        r"## Execution Evidence\n\n```yaml\n.*?^```\n?",
        evidence,
        task_path.read_text(encoding="utf-8"),
        count=1,
        flags=re.MULTILINE | re.DOTALL,
    )
    expect(replacements == 1, f"fixture lacks one Execution Evidence block: {task_path}")
    task_path.write_text(updated, encoding="utf-8")


def conclude_phase(
    root: Path,
    *,
    tests_executed: list[str] | None = None,
    test_result: str = "PASS",
    test_reason: str | None = None,
    validation: str = "PASS",
    corrections: list[str] | None = None,
    revalidation: str = "not_required",
) -> None:
    for path in [root / "execution/plan.md", root / "execution/tasks.md"]:
        text = path.read_text(encoding="utf-8")
        expect("| [ ] | 01" in text, f"fixture lacks open phase row: {path}")
        path.write_text(text.replace("| [ ] | 01", "| [x] | 01", 1), encoding="utf-8")
    task_path = root / "execution/tasks/tasks-01.md"
    text = task_path.read_text(encoding="utf-8")
    expect("- [ ]" in text, f"fixture lacks open task: {task_path}")
    task_path.write_text(text.replace("- [ ]", "- [x]", 1), encoding="utf-8")
    write_evidence(
        root,
        tests_executed=["fixture-test-suite"] if tests_executed is None else tests_executed,
        test_result=test_result,
        test_reason=test_reason,
        validation=validation,
        corrections=[] if corrections is None else corrections,
        revalidation=revalidation,
    )


def replace_task_text(root: Path, old: str, new: str) -> None:
    task_path = root / "execution/tasks/tasks-01.md"
    text = task_path.read_text(encoding="utf-8")
    expect(old in text, f"fixture text is missing {old!r}: {task_path}")
    task_path.write_text(text.replace(old, new, 1), encoding="utf-8")


def check_execution(root: Path) -> None:
    execution = root / "execution"
    files = [root / "feature_spec.md", execution / "plan.md", execution / "plans/plan-01.md", execution / "tasks.md", execution / "tasks/tasks-01.md"]
    for path in files:
        expect(path.exists(), f"delivery workspace missing file: {path}")
    check_header(root / "feature_spec.md", "stnl-spec-lifecycle-manager")
    for path in files[1:]:
        check_header(path, "stnl-spec-execution-manager")

    plan_index = (execution / "plan.md").read_text(encoding="utf-8")
    tasks_index = (execution / "tasks.md").read_text(encoding="utf-8")
    plan = (execution / "plans/plan-01.md").read_text(encoding="utf-8")
    tasks = (execution / "tasks/tasks-01.md").read_text(encoding="utf-8")
    source = (root / "feature_spec.md").read_text(encoding="utf-8")

    expect("requirements_source: ../feature_spec.md" in plan_index, "delivery index source path is missing")
    expect("requirements_source: ../../feature_spec.md" in plan and "requirements_source: ../../feature_spec.md" in tasks, "delivery detailed source path is missing")
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
        task_path = execution / "tasks/tasks-01.md"
        evidence = extract_evidence_fields(task_path)
        validate_concluded_test_evidence(evidence, task_path)
        direct_pass = (
            evidence["validation"] == "PASS"
            and evidence["corrections"] == []
            and evidence["revalidation"] == "not_required"
        )
        corrected_pass = (
            evidence["validation"] == "NEEDS_FIX"
            and isinstance(evidence["corrections"], list)
            and bool(evidence["corrections"])
            and evidence["revalidation"] == "PASS"
        )
        expect(direct_pass or corrected_pass, "concluded phase has an invalid validation history")

    if "| yes | plans/plan-01.md" in plan_index:
        expect("parallel_safety: verified" in plan, "parallel phase lacks verified non-overlap")


def invalid_execution(name: str, mutate, expected_message: str | None = None) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / name
        execution_fixture(root)
        mutate(root)
        try:
            check_execution(root)
        except SystemExit as exc:
            if expected_message is not None:
                expect(expected_message in str(exc), f"invalid delivery fixture {name} failed for the wrong reason: {exc}")
            return
        fail(f"invalid delivery fixture accepted: {name}")


def check_validation_history_matrix(base: Path) -> None:
    for validation in ["pending", "PASS", "NEEDS_FIX"]:
        for corrections in [[], ["fix"]]:
            for revalidation in ["pending", "PASS", "NEEDS_FIX", "not_required"]:
                name = f"validation-{validation}-{'with' if corrections else 'without'}-corrections-{revalidation}"
                root = base / name
                execution_fixture(root)
                conclude_phase(
                    root,
                    validation=validation,
                    corrections=corrections,
                    revalidation=revalidation,
                )
                expected = (
                    validation == "PASS" and not corrections and revalidation == "not_required"
                ) or (
                    validation == "NEEDS_FIX" and bool(corrections) and revalidation == "PASS"
                )
                try:
                    check_execution(root)
                except SystemExit:
                    accepted = False
                else:
                    accepted = True
                expect(accepted == expected, f"validation-history matrix mismatch: {name}")


def external_execution_fixture(base: Path) -> None:
    source = base / "requirements/billing-change.md"
    original = "# Billing change\n\nThe billing behavior is observable.\n"
    write(source, original)
    execution = base / "requirements/billing-change-execution"
    write(execution / "plan.md", header("stnl-spec-execution-manager", "External delivery plan index") + """# Delivery Plan Index

```yaml
requirements_source: ../billing-change.md
execution_workspace: .
```

| Done | Phase | Detail |
|---|---|---|
| [ ] | 01 - Billing | plans/plan-01.md |
""")
    write(execution / "plans/plan-01.md", header("stnl-spec-execution-manager", "External detailed plan") + """# Phase 01 - Billing

```yaml
phase: 01
requirements_source: ../../billing-change.md
```
""")
    write(execution / "tasks.md", header("stnl-spec-execution-manager", "External delivery tasks index") + """# Delivery Tasks Index

| Done | Phase | Detail |
|---|---|---|
| [ ] | 01 - Billing | tasks/tasks-01.md |
""")
    write(execution / "tasks/tasks-01.md", header("stnl-spec-execution-manager", "External detailed task record") + """# Phase 01 Tasks - Billing

```yaml
phase: 01
requirements_source: ../../billing-change.md
```
""")
    expect(source.read_text(encoding="utf-8") == original, "external requirements source changed during planning")
    expect("# File Purpose Header" not in source.read_text(encoding="utf-8"), "external requirements source requires a lifecycle header")
    expect(not (base / "requirements/feature_spec.md").exists(), "external requirements source was renamed")
    plan_index = (execution / "plan.md").read_text(encoding="utf-8")
    detailed_plan = (execution / "plans/plan-01.md").read_text(encoding="utf-8")
    tasks = (execution / "tasks/tasks-01.md").read_text(encoding="utf-8")
    expect("requirements_source: ../billing-change.md" in plan_index, "external plan index lacks relative source")
    expect("requirements_source: ../../billing-change.md" in detailed_plan and "requirements_source: ../../billing-change.md" in tasks, "external detailed artifacts lack relative source")
    expect("plans/plan-01.md" in plan_index and "tasks/tasks-01.md" in (execution / "tasks.md").read_text(encoding="utf-8"), "external execution workspace has broken indices")
    for path in [execution / "plan.md", execution / "plans/plan-01.md", execution / "tasks.md", execution / "tasks/tasks-01.md"]:
        check_header(path, "stnl-spec-execution-manager")


def static_contract_checks() -> None:
    for root, owner in [(SPEC_ROOT, "stnl-spec-lifecycle-manager"), (EXEC_ROOT, "stnl-spec-execution-manager")]:
        for folder in ["references", "templates", "examples", "evals"]:
            for path in (root / folder).glob("*.md"):
                check_header(path, owner)
    spec_forbidden = re.compile(
        rf"plan\\.md|tasks\\.md|plans/|tasks/|phase-execute|phase-validate|{re.escape(LEGACY_PHASE_FIX)}|phase-commit|phase-parallel|independent validation|implementation phase",
        re.IGNORECASE,
    )
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

    closed_spec_with_execution = base / "closed-spec-with-execution"
    execution_fixture(closed_spec_with_execution)
    write(closed_spec_with_execution / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Closed feature SPEC", "closed") + "# Closed SPEC\n")
    execution_snapshot = snapshot_tree(closed_spec_with_execution / "execution")
    check_spec_closed(closed_spec_with_execution)
    expect(
        snapshot_tree(closed_spec_with_execution / "execution") == execution_snapshot,
        "documentary CLOSE validation changed the execution workspace",
    )

    closed_spec_with_external = base / "closed-spec-with-external"
    write(closed_spec_with_external / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Closed feature SPEC", "closed") + "# Closed SPEC\n")
    write(closed_spec_with_external / "attachments/context.txt", "Opaque external context without a lifecycle header.\n")
    check_spec_closed(closed_spec_with_external)

    invalid_closed_spec = base / "invalid-closed-spec"
    write(invalid_closed_spec / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Closed feature SPEC", "closed") + "# Closed SPEC\n")
    write(invalid_closed_spec / "shared/questions.md", "Lifecycle residue.\n")
    try:
        check_spec_closed(invalid_closed_spec)
    except SystemExit:
        pass
    else:
        fail("invalid closed SPEC with shared residue accepted")

    missing_final_spec = base / "missing-final-spec"
    write(missing_final_spec / "attachments/context.txt", "No lifecycle artifact is present.\n")
    try:
        check_spec_closed(missing_final_spec)
    except SystemExit:
        pass
    else:
        fail("closed SPEC without feature_spec.md accepted")

    active_execution = base / "active-execution"
    execution_fixture(active_execution)
    check_execution(active_execution)

    invalid_execution("missing-plan", lambda root: (root / "execution/plans/plan-01.md").unlink())
    invalid_execution("wrong-task-plan", lambda root: (root / "execution/tasks/tasks-01.md").write_text((root / "execution/tasks/tasks-01.md").read_text(encoding="utf-8").replace("plans/plan-01.md", "plans/plan-02.md"), encoding="utf-8"))
    invalid_execution("missing-ac", lambda root: (root / "execution/tasks/tasks-01.md").write_text((root / "execution/tasks/tasks-01.md").read_text(encoding="utf-8").replace("AC-001", "AC-999"), encoding="utf-8"))
    invalid_execution("completed-open-task", lambda root: ((root / "execution/plan.md").write_text((root / "execution/plan.md").read_text(encoding="utf-8").replace("| [ ] | 01", "| [x] | 01"), encoding="utf-8"), (root / "execution/tasks.md").write_text((root / "execution/tasks.md").read_text(encoding="utf-8").replace("| [ ] | 01", "| [x] | 01"), encoding="utf-8")))
    invalid_execution("parallel-without-safety", lambda root: (root / "execution/plan.md").write_text((root / "execution/plan.md").read_text(encoding="utf-8").replace("| no | plans/plan-01.md", "| yes | plans/plan-01.md"), encoding="utf-8"))

    initial_pass = base / "initial-pass"
    execution_fixture(initial_pass)
    conclude_phase(initial_pass)
    check_execution(initial_pass)

    corrected_pass = base / "corrected-pass"
    execution_fixture(corrected_pass)
    conclude_phase(corrected_pass, validation="NEEDS_FIX", corrections=["fix"], revalidation="PASS")
    check_execution(corrected_pass)

    one_test_pass = base / "one-test-pass"
    execution_fixture(one_test_pass)
    conclude_phase(one_test_pass, tests_executed=["unit tests"])
    check_execution(one_test_pass)

    multiple_tests_pass = base / "multiple-tests-pass"
    execution_fixture(multiple_tests_pass)
    conclude_phase(multiple_tests_pass, tests_executed=["unit tests", "integration tests"])
    check_execution(multiple_tests_pass)

    not_applicable_pass = base / "not-applicable-pass"
    execution_fixture(not_applicable_pass)
    conclude_phase(
        not_applicable_pass,
        tests_executed=[],
        test_result="not_applicable",
        test_reason="Mudança exclusivamente documental sem comportamento executável.",
    )
    check_execution(not_applicable_pass)

    corrected_not_applicable_pass = base / "corrected-not-applicable-pass"
    execution_fixture(corrected_not_applicable_pass)
    conclude_phase(
        corrected_not_applicable_pass,
        tests_executed=[],
        test_result="not_applicable",
        test_reason="Mudança exclusivamente documental sem comportamento executável.",
        validation="NEEDS_FIX",
        corrections=["fix documentation"],
        revalidation="PASS",
    )
    check_execution(corrected_not_applicable_pass)

    invalid_execution(
        "corrections-without-revalidation",
        lambda root: conclude_phase(root, validation="NEEDS_FIX", corrections=["fix"], revalidation="pending"),
    )
    invalid_execution(
        "corrections-with-failed-revalidation",
        lambda root: conclude_phase(root, validation="NEEDS_FIX", corrections=["fix"], revalidation="NEEDS_FIX"),
    )
    invalid_execution(
        "needs-fix-without-corrections",
        lambda root: conclude_phase(root, validation="NEEDS_FIX", revalidation="PASS"),
    )
    invalid_execution(
        "initial-pass-with-artificial-revalidation",
        lambda root: conclude_phase(root, revalidation="PASS"),
    )
    invalid_execution(
        "initial-pass-with-corrections",
        lambda root: conclude_phase(root, corrections=["fix"]),
    )
    invalid_execution(
        "concluded-with-pending-validation",
        lambda root: conclude_phase(root, validation="pending", revalidation="pending"),
    )
    invalid_execution(
        "pass-without-tests",
        lambda root: conclude_phase(root, tests_executed=[], test_result="PASS"),
        "PASS test_result requires at least one tests_executed item",
    )
    invalid_execution(
        "missing-tests-executed",
        lambda root: (
            conclude_phase(root),
            replace_task_text(root, "tests_executed:\n  - fixture-test-suite\n", ""),
        ),
        "missing evidence field tests_executed",
    )
    invalid_execution(
        "duplicate-tests-executed",
        lambda root: (
            conclude_phase(root),
            replace_task_text(
                root,
                "tests_executed:\n  - fixture-test-suite\n",
                "tests_executed:\n  - fixture-test-suite\ntests_executed:\n  - unit tests\n",
            ),
        ),
        "duplicate evidence field tests_executed",
    )
    invalid_execution(
        "malformed-tests-list",
        lambda root: (
            conclude_phase(root),
            replace_task_text(root, "tests_executed:\n  - fixture-test-suite\n", "tests_executed:\n  unit tests\n"),
        ),
        "malformed tests_executed list item",
    )
    invalid_execution(
        "empty-test-item",
        lambda root: (
            conclude_phase(root),
            replace_task_text(root, "  - fixture-test-suite", "  - "),
        ),
        "empty tests_executed entry",
    )
    invalid_execution(
        "inline-filled-tests-list",
        lambda root: (
            conclude_phase(root),
            replace_task_text(root, "tests_executed:\n  - fixture-test-suite\n", "tests_executed: [unit tests]\n"),
        ),
        "malformed tests_executed list",
    )
    invalid_execution(
        "not-applicable-with-tests",
        lambda root: conclude_phase(
            root,
            tests_executed=["unit tests"],
            test_result="not_applicable",
            test_reason="Mudança documental sem comportamento executável.",
        ),
        "not_applicable test_result requires empty tests_executed",
    )
    invalid_execution(
        "not-applicable-without-reason",
        lambda root: conclude_phase(root, tests_executed=[], test_result="not_applicable"),
        "not_applicable test_result requires test_reason",
    )
    invalid_execution(
        "not-applicable-empty-reason",
        lambda root: conclude_phase(root, tests_executed=[], test_result="not_applicable", test_reason=""),
        "empty test_reason",
    )
    invalid_execution(
        "not-applicable-generic-reason",
        lambda root: conclude_phase(root, tests_executed=[], test_result="not_applicable", test_reason="n/a"),
        "generic test_reason value",
    )
    invalid_execution(
        "pass-with-test-reason",
        lambda root: conclude_phase(root, test_reason="Testes executados."),
        "test_reason is only allowed with not_applicable test_result",
    )
    invalid_execution(
        "concluded-with-pending-tests",
        lambda root: conclude_phase(root, test_result="pending"),
        "concluded phase has invalid test_result 'pending'",
    )
    invalid_execution(
        "concluded-with-needs-fix-tests",
        lambda root: conclude_phase(root, test_result="NEEDS_FIX"),
        "concluded phase has invalid test_result 'NEEDS_FIX'",
    )
    invalid_execution(
        "concluded-with-invalid-test-result",
        lambda root: conclude_phase(root, test_result="BROKEN"),
        "invalid test_result value 'BROKEN'",
    )
    invalid_execution(
        "unknown-evidence-field",
        lambda root: (
            conclude_phase(root),
            replace_task_text(root, "test_result: PASS\n", "test_result: PASS\nunknown_field: value\n"),
        ),
        "unknown evidence field unknown_field",
    )
    invalid_execution(
        "indented-item-without-active-list",
        lambda root: (
            conclude_phase(root),
            replace_task_text(root, "test_result: PASS\n", "test_result: PASS\n  - stray item\n"),
        ),
        "list item without active evidence list",
    )
    invalid_execution(
        "tests-item-under-corrections",
        lambda root: conclude_phase(root, tests_executed=[], corrections=["unit tests"]),
        "PASS test_result requires at least one tests_executed item",
    )
    invalid_execution(
        "correction-item-under-tests",
        lambda root: conclude_phase(root, tests_executed=["fix applied"], validation="NEEDS_FIX", corrections=[], revalidation="PASS"),
        "concluded phase has an invalid validation history",
    )
    invalid_execution(
        "missing-evidence-field",
        lambda root: (conclude_phase(root), replace_task_text(root, "validation: PASS\n", "")),
    )
    invalid_execution(
        "duplicate-evidence-field",
        lambda root: (conclude_phase(root), replace_task_text(root, "validation: PASS\n", "validation: PASS\nvalidation: PASS\n")),
    )
    invalid_execution(
        "invalid-evidence-value",
        lambda root: (conclude_phase(root), replace_task_text(root, "validation: PASS", "validation: UNKNOWN")),
    )
    invalid_execution(
        "malformed-corrections-list",
        lambda root: (conclude_phase(root), replace_task_text(root, "corrections: []", "corrections: [fix]")),
    )
    check_validation_history_matrix(base)

    external_execution_fixture(base / "external-source")

    static_contract_checks()

print("PASS: SPEC workspace structural smoke validation")
print("PASS: documentary CLOSE ownership fixtures")
print("PASS: delivery workspace structural smoke validation")
print("PASS: delivery validation-history fixtures")
print("PASS: external requirements source structural smoke validation")
PY
