#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
cd "$ROOT"

"$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import hashlib
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path("scripts").resolve()))

from validate_spec_lifecycle import ValidationError, validate_workspace


FIELDS = ["purpose", "status", "read_when", "do_not_read_when", "contains", "owner", "update_policy"]
STATUSES = {"draft", "ready", "blocked", "done", "closed", "not_applicable"}
SPEC_ROOT = Path("skills/stnl-spec-lifecycle-manager")
EXEC_ROOT = Path("skills/stnl-spec-execution-manager")
EVIDENCE_SCALAR_VALUES = {
    "test_result": {"pending", "PASS", "not_applicable"},
    "validation": {"pending", "PASS", "NEEDS_FIX"},
    "revalidation": {"pending", "PASS", "NEEDS_FIX", "not_required"},
}
REQUIRED_EVIDENCE_FIELDS = ["tests_executed", "test_result", "validation", "corrections", "revalidation"]
GENERIC_TEST_REASONS = {"none", "n/a", "na", "not applicable", "not_applicable"}
EVIDENCE_LABELS = {
    "Testes executados": "tests_executed",
    "Resultado dos testes": "test_result",
    "Justificativa sem teste": "test_reason",
    "Validação": "validation",
    "Correções": "corrections",
    "Revalidação": "revalidation",
}
EVIDENCE_LIST_FIELDS = {"tests_executed", "corrections"}


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
    write(root / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Fixture feature SPEC", "ready") + """# Fixture Feature SPEC

## Objective

Deliver the fixture behavior.

## Context

### Facts

- The fixture has one observable behavior.

### Hypotheses

- None identified.

## Scope

- Include the observable fixture behavior.

## Out of Scope

- Delivery workflow behavior.

## Requirements

- The fixture result is deterministic.

## Business Rules

- None.

## Relevant Contracts

- `docs/core/CONTRACTS.md §5` is external narrative context.

## Canonical Artifact Index

```yaml
artifacts:
  acceptance_criteria: shared/acceptance-criteria.md
  decisions: shared/decisions.md
```

## Blockers

```yaml
open_questions: []
broken_references: []
documentary_gaps: []
```

## Selective Reading

Read this file, then only the indexed category and necessary structural links.
""")
    write(root / "shared/acceptance-criteria.md", header("stnl-spec-lifecycle-manager", "Fixture acceptance criteria") + """# Acceptance Criteria

### AC-001 — Observable behavior

- status: active
- references: [D-001]

Given the fixture input, when the behavior runs, then the visible result returns `fixture-ok`.
""")
    write(root / "shared/decisions.md", header("stnl-spec-lifecycle-manager", "Fixture decisions") + """# Decisions

### D-001 — Fixture boundary

- status: accepted
- references: [AC-001]

#### Contexto

The smoke test needs a stable local boundary.

#### Decisão

Keep the fixture local to its temporary workspace.

#### Impacto

The result remains isolated and deterministic.
""")


def check_ids(path: Path) -> set[str]:
    text = path.read_text(encoding="utf-8")
    headings = set(re.findall(r"^### ((?:Q|D|AC|R|C)-\d{3}) — \S", text, re.MULTILINE))
    expect(re.search(r"(?m)^id:\s*(?:Q|D|AC|R|C)-\d{3}$", text) is None, f"duplicate canonical id field: {path}")
    expect("```yaml\nid:" not in text, f"canonical item YAML remains: {path}")
    return headings


def check_spec_active(root: Path) -> None:
    feature = root / "feature_spec.md"
    expect(feature.exists(), "SPEC workspace missing feature_spec.md")
    check_header(feature, "stnl-spec-lifecycle-manager")
    for name in ["plan.md", "tasks.md", "plans", "tasks"]:
        expect(not (root / name).exists(), f"SPEC workspace contains execution artifact: {name}")
    expect((root / "shared/acceptance-criteria.md").exists(), "SPEC workspace missing materialized ACs")
    available: set[str] = set()
    for path in (root / "shared").glob("*.md"):
        check_header(path, "stnl-spec-lifecycle-manager")
        available |= check_ids(path)
    feature_text = feature.read_text(encoding="utf-8")
    expect({"AC-001", "D-001"} <= available, "SPEC fixture lacks canonical records")
    expect("Selective Reading" in feature_text, "SPEC feature document lacks selective reading")
    workspace = validate_workspace(root)
    expect(workspace.status == "ready" and set(workspace.items) == {"AC-001", "D-001"}, "active SPEC validator rejected canonical fixture")


def check_spec_blocked(root: Path) -> None:
    for path in [root / "feature_spec.md", root / "shared/questions.md"]:
        expect(path.exists(), f"blocked SPEC missing file: {path}")
        check_header(path, "stnl-spec-lifecycle-manager")
    questions = (root / "shared/questions.md").read_text(encoding="utf-8")
    expect("Q-001" in questions and "status: open" in questions, "blocked question is malformed")
    for name in ["plan.md", "tasks.md", "plans", "tasks"]:
        expect(not (root / name).exists(), f"blocked SPEC contains execution artifact: {name}")
    workspace = validate_workspace(root)
    expect(workspace.status == "blocked" and workspace.open_questions == ("Q-001",), "blocked SPEC validator rejected open question")


def check_spec_closed(root: Path) -> None:
    feature = root / "feature_spec.md"
    expect(feature.exists(), "closed SPEC missing feature_spec.md")
    check_header(feature, "stnl-spec-lifecycle-manager")
    expect(not (root / "shared").exists(), "closed SPEC retains lifecycle shared/ residue")
    workspace = validate_workspace(root)
    expect(workspace.status == "closed", "closed SPEC validator rejected durable fixture")


def blocked_spec_fixture(root: Path) -> None:
    write(root / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Blocked feature SPEC", "blocked") + """# Blocked SPEC

## Objective

Define the fixture scope.

## Context

### Facts

- The requested behavior exists.

### Hypotheses

- The final scope is not yet known.

## Scope

- Behavior confirmed by the pending answer.

## Out of Scope

- Unconfirmed behavior.

## Requirements

- The chosen scope must be explicit.

## Business Rules

- None.

## Relevant Contracts

- None.

## Canonical Artifact Index

```yaml
artifacts:
  questions: shared/questions.md
```

## Blockers

```yaml
open_questions: [Q-001]
broken_references: []
documentary_gaps: []
```

## Selective Reading

Read Q-001 only when resolving the global blocker.
""")
    write(root / "shared/questions.md", header("stnl-spec-lifecycle-manager", "Blocking questions", "blocked") + """# Questions

### Q-001 — Scope

- status: open
- blocks: []

#### Pergunta

Which fixture behavior is in scope?

#### Por que importa

The answer defines the global documentary boundary.

#### Resolução

Pendente.
""")


def closed_spec_fixture(root: Path) -> None:
    write(root / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Closed feature SPEC", "closed") + """# Closed SPEC

## Objective

Preserve the durable fixture requirement.

## Context

### Facts

- The durable fixture behavior is known.

### Hypotheses

- None identified.

## Final Scope

- The fixture behavior remains included.

## Out of Scope

- Operational workflow behavior.

## Requirements

- The fixture result stays deterministic.

## Business Rules

- None.

## Important Contracts

- None.
""")


def snapshot_tree(root: Path) -> tuple[tuple[str, str, str], ...]:
    snapshot: list[tuple[str, str, str]] = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(root).as_posix()
        if path.is_dir():
            snapshot.append(("directory", relative, ""))
        else:
            snapshot.append(("file", relative, hashlib.sha256(path.read_bytes()).hexdigest()))
    return tuple(snapshot)


def task_path(root: Path, number: str) -> Path:
    return root / "execution/tasks" / f"slice-{number}.md"


def plan_path(root: Path, number: str) -> Path:
    return root / "execution/plans" / f"slice-{number}.md"


def slice_plan(number: str, name: str, requirement: str, dependency: str, *, parallel: bool = False) -> str:
    return header("stnl-spec-execution-manager", f"Fixture detailed slice {number} plan") + f"""# Slice {number} - {name}

## Referências

- Slice: {number}
- Fonte de requisitos: `../../feature_spec.md`
- Plano global: `../plan.md`

## Objective

Deliver {name.lower()}.

## Observable Result

{name} can be verified independently.

## Requirements References

- {requirement}

## Included Scope

- Fixture work for {name}.

## Out of Scope

- Work reserved for other slices.

## Boundaries With Other Slices

- Depends on: {dependency}

## Likely Areas

- fixture/{number}

## Dependencies

- {dependency}

## Risks

- None beyond fixture scope.

## Strategy

Make the smallest observable change for this slice.

## Expected Tests or Validation

- fixture-test-{number}

## Critério de conclusão

- {name} can be verified independently.
- fixture-test-{number} passes or has an objective not-applicable reason.
- Work reserved for other slices remains untouched.

## Parallelization Assessment

- Eligible: {'yes' if parallel else 'no'}
- Non-overlap justification: {'no shared files, state, contracts, fixtures, generated code, or mutable resources' if parallel else 'not_applicable'}
"""


def slice_tasks(number: str, name: str, requirement: str) -> str:
    return header("stnl-spec-execution-manager", f"Fixture detailed slice {number} tasks") + f"""# Slice {number} Tasks - {name}

## Referências

- Slice: {number}
- Plano: `../plans/slice-{number}.md`
- Fonte de requisitos: `../../feature_spec.md`
- Índice global: `../tasks.md`

## Checklist

- [ ] {int(number)}.1 Deliver {name.lower()} | expected areas: fixture/{number} | acceptance: {requirement}

## Expected Tests

- fixture-test-{number}

## Changed Areas

- pending

## Scope Expansion

- none

## Divergências

- nenhuma

## Execution Evidence

- Testes executados: nenhum
- Resultado dos testes: pending
- Validação: pending
- Correções: nenhuma
- Revalidação: pending

## Validation Findings

- pending

## Corrections Applied

- pending

## Revalidation

- pending

## Diff Summary

- pending

## Final Result

- pending
"""


def execution_fixture(root: Path) -> None:
    write(root / "feature_spec.md", header("stnl-spec-lifecycle-manager", "Fixture requirements source", "closed") + """# Fixture Requirements

## Objective

Deliver three observable fixture behaviors.

## Context

### Facts

- The requirements source is documentary and closed.

### Hypotheses

- None identified.

## Final Scope

- Domain, API, and maintenance fixture behavior.

## Out of Scope

- Additional fixture behavior.

## Requirements

- Each behavior is independently observable.

## Business Rules

- None.

## Final Acceptance Criteria

### AC-001 — Domain behavior

- status: active

Given a domain input, when it is handled, then the domain result returns `domain-ok`.

### AC-002 — API behavior

- status: active

Given an API request, when it is handled, then the response returns HTTP 200 with `api-ok`.

### AC-003 — Maintenance behavior

- status: active

Given a maintenance trigger, when it runs, then the visible report contains `maintenance-ok`.

## Important Contracts

- None.
""")
    execution = root / "execution"
    write(execution / "plan.md", header("stnl-spec-execution-manager", "Fixture global execution plan") + """# Execution Plan

## Global Context

- Fonte de requisitos: `../feature_spec.md`
- Execution root: `.`
- Objetivo geral: Deliver three fixture behaviors.
- Estratégia: Build domain behavior first, then API behavior, then maintenance behavior.

## Slice Order

| Slice | Summary | Dependencies | Covered Requirements | Expected Areas | Parallelization | Detailed Plan |
|---|---|---|---|---|---|---|
| 01 - Domain | Fixture domain behavior becomes observable | - | AC-001 | fixture/01 | no: foundational behavior | plans/slice-01.md |
| 02 - API | Fixture API behavior becomes observable | 01 | AC-002 | fixture/02 | no: depends on 01 | plans/slice-02.md |
| 03 - Maintenance | Fixture maintenance behavior becomes observable | 02 | AC-003 | fixture/03 | no: depends on 02 | plans/slice-03.md |

## Global Notes

- Requirements source remains authoritative.
- tasks.md is the only global progress authority.
""")
    write(plan_path(root, "01"), slice_plan("01", "Domain", "AC-001", "none"))
    write(plan_path(root, "02"), slice_plan("02", "API", "AC-002", "01"))
    write(plan_path(root, "03"), slice_plan("03", "Maintenance", "AC-003", "02"))
    write(execution / "tasks.md", header("stnl-spec-execution-manager", "Fixture global execution tasks") + """# Execution Tasks

## Progress Authority

Use only `[ ]` and `[x]`. This file is the canonical global progress authority.

| Done | Slice | Delivery | Dependencies | Detail | Tests | Validation | Result |
|---|---|---|---|---|---|---|---|
| [ ] | 01 - Domain | Domain behavior | - | tasks/slice-01.md | pending | pending | - |
| [ ] | 02 - API | API behavior | 01 | tasks/slice-02.md | pending | pending | - |
| [ ] | 03 - Maintenance | Maintenance behavior | 02 | tasks/slice-03.md | pending | pending | - |
""")
    write(task_path(root, "01"), slice_tasks("01", "Domain", "AC-001"))
    write(task_path(root, "02"), slice_tasks("02", "API", "AC-002"))
    write(task_path(root, "03"), slice_tasks("03", "Maintenance", "AC-003"))


def parse_task_rows(root: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for line in (root / "execution/tasks.md").read_text(encoding="utf-8").splitlines():
        if not line.startswith("| ["):
            continue
        parts = [part.strip() for part in line.strip().strip("|").split("|")]
        expect(len(parts) == 8, f"malformed tasks row: {line}")
        done, slice_label, delivery, dependencies, detail, tests, validation, result = parts
        match = re.match(r"^(\d{2}) - .+$", slice_label)
        expect(match is not None, f"malformed slice label: {slice_label}")
        rows.append({
            "done": done,
            "number": match.group(1),
            "delivery": delivery,
            "dependencies": dependencies,
            "detail": detail,
            "tests": tests,
            "validation": validation,
            "result": result,
        })
    expect(rows, "tasks.md has no slice rows")
    return rows


def dependency_numbers(value: str) -> set[str]:
    if value in {"", "-"}:
        return set()
    return {part.strip() for part in value.split(",") if part.strip()}


def has_divergencia_bloqueante(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    section = extract_section_text(text, "Divergências", path)
    lines = [line.rstrip() for line in section.splitlines() if line.strip()]
    expect(lines, f"empty Divergências section: {path}")
    has_none = any(re.fullmatch(r"-\s+nenhuma", line.strip(), re.IGNORECASE) for line in lines)
    has_real = any(re.fullmatch(r"-\s+Tipo:\s+.+", line.strip()) for line in lines)
    if has_none:
        expect(len(lines) == 1 and not has_real, f"Divergências mixes none with real divergences: {path}")
        return False
    expect(has_real, f"Divergências lacks '- nenhuma' or divergence entries: {path}")

    blocking = False
    index = 0
    required = ["Descrição", "Impacto", "Decisão necessária", "Bloqueante"]
    while index < len(lines):
        type_line = lines[index].strip()
        expect(re.fullmatch(r"-\s+Tipo:\s+.+", type_line) is not None, f"malformed divergence type line: {path}")
        index += 1
        fields: dict[str, str] = {}
        while index < len(lines) and not lines[index].startswith("- Tipo:"):
            match = re.fullmatch(r"\s{2}-\s+([^:]+):\s*(.+)", lines[index])
            expect(match is not None, f"malformed divergence field line: {path}")
            key, value = match.groups()
            expect(key in required, f"unknown divergence field {key}: {path}")
            expect(key not in fields, f"duplicate divergence field {key}: {path}")
            fields[key] = value.strip()
            index += 1
        for key in required:
            expect(key in fields, f"missing divergence field {key}: {path}")
        flag = fields["Bloqueante"].lower()
        expect(flag in {"sim", "não"}, f"invalid Bloqueante value {fields['Bloqueante']!r}: {path}")
        blocking = blocking or flag == "sim"
    return blocking


def eligible_slices(root: Path) -> list[str]:
    rows = parse_task_rows(root)
    done = {row["number"] for row in rows if row["done"] == "[x]"}
    eligible: list[str] = []
    for row in rows:
        if row["done"] != "[ ]":
            continue
        has_blocking_divergence = has_divergencia_bloqueante(root / "execution" / row["detail"])
        if dependency_numbers(row["dependencies"]) <= done and not has_blocking_divergence:
            eligible.append(row["number"])
    return eligible


def extract_section_text(text: str, heading: str, path: Path) -> str:
    pattern = rf"^## {re.escape(heading)}\n\n(.*?)(?=^## |\Z)"
    matches = re.findall(pattern, text, re.MULTILINE | re.DOTALL)
    expect(len(matches) == 1, f"expected exactly one {heading} section: {path}")
    return matches[0]


def extract_evidence_fields(path: Path) -> dict[str, str | list[str]]:
    text = path.read_text(encoding="utf-8")
    section = extract_section_text(text, "Execution Evidence", path)
    fields: dict[str, str | list[str]] = {}
    lines = section.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        if line.startswith("  - "):
            fail(f"list item without active evidence list: {path}")
        match = re.match(r"^- ([^:]+):(.*)$", line)
        expect(match is not None, f"malformed evidence line {line!r}: {path}")
        label, raw_value = match.groups()
        expect(label in EVIDENCE_LABELS, f"unknown evidence field {label}: {path}")
        field = EVIDENCE_LABELS[label]
        if field not in EVIDENCE_LIST_FIELDS:
            expect(field not in fields, f"duplicate evidence field {field}: {path}")
            value = raw_value.strip()
            if field == "test_reason":
                expect(value, f"empty test_reason: {path}")
                expect(value.lower() not in GENERIC_TEST_REASONS, f"generic test_reason value {value!r}: {path}")
            else:
                expect(value in EVIDENCE_SCALAR_VALUES[field], f"invalid {field} value {value!r}: {path}")
            fields[field] = value
        else:
            expect(field not in fields, f"duplicate evidence field {field}: {path}")
            value = raw_value.strip()
            if value == "nenhum":
                fields[field] = []
            else:
                expect(not value, f"malformed {field} list: {path}")
                items: list[str] = []
                index += 1
                while index < len(lines):
                    item_line = lines[index]
                    if item_line.startswith("  -"):
                        expect(item_line.startswith("  - "), f"empty {field} entry: {path}")
                        item = item_line[4:].strip().strip("`")
                        expect(item, f"empty {field} entry: {path}")
                        items.append(item)
                        index += 1
                        continue
                    if item_line.startswith(" "):
                        fail(f"malformed {field} list item: {path}")
                    break
                expect(items, f"malformed {field} list: {path}")
                fields[field] = items
                continue
        index += 1
    for field in REQUIRED_EVIDENCE_FIELDS:
        expect(field in fields, f"missing evidence field {field}: {path}")
    if "test_reason" in fields:
        expect(fields["test_result"] == "not_applicable", f"test_reason is only allowed with not_applicable test_result: {path}")
    return fields


def render_list_field(label: str, values: list[str]) -> str:
    if not values:
        return f"- {label}: nenhum"
    return "\n".join([f"- {label}:", *[f"  - {value}" for value in values]])


def write_evidence(
    root: Path,
    number: str,
    *,
    tests_executed: list[str],
    test_result: str,
    test_reason: str | None,
    validation: str,
    corrections: list[str],
    revalidation: str,
) -> None:
    reason_line = f"- Justificativa sem teste: {test_reason}\n" if test_reason is not None else ""
    evidence = f"""## Execution Evidence

{render_list_field("Testes executados", tests_executed)}
- Resultado dos testes: {test_result}
{reason_line}- Validação: {validation}
{render_list_field("Correções", corrections)}
- Revalidação: {revalidation}
"""
    path = task_path(root, number)
    updated, replacements = re.subn(
        r"## Execution Evidence\n\n.*?(?=^## |\Z)",
        evidence,
        path.read_text(encoding="utf-8"),
        count=1,
        flags=re.MULTILINE | re.DOTALL,
    )
    expect(replacements == 1, f"fixture lacks one Execution Evidence block: {path}")
    path.write_text(updated, encoding="utf-8")


def replace_section(path: Path, heading: str, body: str) -> None:
    text = path.read_text(encoding="utf-8")
    pattern = rf"(^## {re.escape(heading)}\n\n)(.*?)(?=^## |\Z)"
    updated, replacements = re.subn(pattern, rf"\1{body.rstrip()}\n\n", text, count=1, flags=re.MULTILINE | re.DOTALL)
    expect(replacements == 1, f"missing section {heading}: {path}")
    path.write_text(updated, encoding="utf-8")


def update_task_row(root: Path, number: str, *, done: str, tests: str, validation: str, result: str) -> None:
    path = root / "execution/tasks.md"
    lines = path.read_text(encoding="utf-8").splitlines()
    updated: list[str] = []
    changed = False
    for line in lines:
        if line.startswith(f"| [") and f"| {number} - " in line:
            parts = [part.strip() for part in line.strip().strip("|").split("|")]
            parts[0] = done
            parts[5] = tests
            parts[6] = validation
            parts[7] = result
            line = "| " + " | ".join(parts) + " |"
            changed = True
        updated.append(line)
    expect(changed, f"missing tasks row for slice {number}")
    path.write_text("\n".join(updated) + "\n", encoding="utf-8")


def conclude_slice(
    root: Path,
    number: str = "01",
    *,
    tests_executed: list[str] | None = None,
    test_result: str = "PASS",
    test_reason: str | None = None,
    validation: str = "PASS",
    corrections: list[str] | None = None,
    revalidation: str = "not_required",
) -> None:
    path = task_path(root, number)
    text = path.read_text(encoding="utf-8")
    expect("- [ ]" in text, f"fixture lacks open task: {path}")
    path.write_text(text.replace("- [ ]", "- [x]", 1), encoding="utf-8")
    write_evidence(
        root,
        number,
        tests_executed=[f"fixture-test-{number}"] if tests_executed is None else tests_executed,
        test_result=test_result,
        test_reason=test_reason,
        validation=validation,
        corrections=[] if corrections is None else corrections,
        revalidation=revalidation,
    )
    replace_section(path, "Changed Areas", f"- fixture/{number}")
    replace_section(path, "Diff Summary", f"- Implemented fixture slice {number}.")
    replace_section(path, "Final Result", f"- Done: fixture slice {number}.")
    if validation == "NEEDS_FIX":
        replace_section(path, "Validation Findings", "- Problem: fixture gap\n- Evidence: validator found the gap\n- Impact: requirement incomplete\n- Related reference: task finding\n- Expected correction: fix the gap")
        replace_section(path, "Corrections Applied", "- Fixed persisted validation finding.")
        replace_section(path, "Revalidation", f"- {revalidation}")
    else:
        replace_section(path, "Validation Findings", "- none")
        replace_section(path, "Corrections Applied", "- none")
        replace_section(path, "Revalidation", f"- {revalidation}")
    update_task_row(root, number, done="[x]", tests=test_result, validation=validation if validation == "PASS" else revalidation, result=f"Done: fixture slice {number}")


def validate_concluded_test_evidence(evidence: dict[str, str | list[str]], path: Path) -> None:
    tests_executed = evidence["tests_executed"]
    expect(isinstance(tests_executed, list), f"tests_executed is not a list: {path}")
    test_result = evidence["test_result"]
    expect(isinstance(test_result, str), f"test_result is not scalar: {path}")
    if test_result == "PASS":
        expect(bool(tests_executed), f"PASS test_result requires at least one tests_executed item: {path}")
        expect("test_reason" not in evidence, f"test_reason is only allowed with not_applicable test_result: {path}")
        return
    if test_result == "not_applicable":
        expect(tests_executed == [], f"not_applicable test_result requires empty tests_executed: {path}")
        expect("test_reason" in evidence, f"not_applicable test_result requires test_reason: {path}")
        return
    fail(f"concluded slice has invalid test_result {test_result!r}: {path}")


def check_execution(root: Path) -> None:
    execution = root / "execution"
    expected = [
        root / "feature_spec.md",
        execution / "plan.md",
        execution / "tasks.md",
        plan_path(root, "01"),
        plan_path(root, "02"),
        plan_path(root, "03"),
        task_path(root, "01"),
        task_path(root, "02"),
        task_path(root, "03"),
    ]
    for path in expected:
        expect(path.exists(), f"execution workspace missing file: {path}")
    check_header(root / "feature_spec.md", "stnl-spec-lifecycle-manager")
    for path in expected[1:]:
        check_header(path, "stnl-spec-execution-manager")

    source = (root / "feature_spec.md").read_text(encoding="utf-8")
    plan_index = (execution / "plan.md").read_text(encoding="utf-8")
    tasks_index = (execution / "tasks.md").read_text(encoding="utf-8")
    expect("- Fonte de requisitos: `../feature_spec.md`" in plan_index, "global plan source path is missing")
    expect("[ ]" not in plan_index and "[x]" not in plan_index, "plan.md duplicates progress checkboxes")
    expect("tasks.md is the only global progress authority" in plan_index, "plan.md lacks progress boundary note")
    expect("Fixture domain behavior becomes observable" in plan_index, "plan.md lacks useful slice summary")
    expect("plans/slice-01.md" in plan_index and "plans/slice-03.md" in plan_index, "global plan lacks detailed slice paths")
    expect("tasks/slice-01.md" in tasks_index and "tasks/slice-03.md" in tasks_index, "tasks.md lacks materialized detailed task paths")

    rows = parse_task_rows(root)
    expect([row["number"] for row in rows] == ["01", "02", "03"], "tasks.md slice sequence mismatch")
    for row in rows:
        number = row["number"]
        p_plan = plan_path(root, number)
        p_task = task_path(root, number)
        plan_text = p_plan.read_text(encoding="utf-8")
        task_text = p_task.read_text(encoding="utf-8")
        has_blocking_divergence = has_divergencia_bloqueante(p_task)
        expect(f"- Slice: {number}" in plan_text and f"- Slice: {number}" in task_text, f"slice reference mismatch: {number}")
        expect("- Fonte de requisitos: `../../feature_spec.md`" in plan_text, f"detailed plan source path mismatch: {number}")
        expect("- Fonte de requisitos: `../../feature_spec.md`" in task_text, f"detailed task source path mismatch: {number}")
        expect(f"- Plano: `../plans/slice-{number}.md`" in task_text, f"task record points to wrong plan: {number}")
        expect("## Critério de conclusão" in plan_text, f"detailed plan lacks completion criterion: {number}")
        expect("## Divergências" in task_text, f"detailed task lacks divergence section: {number}")
        expect(canonical_ids(plan_text + task_text) <= canonical_ids(source), f"execution references missing criterion: {number}")
        if row["done"] == "[x]":
            expect("- [ ]" not in task_text, f"concluded slice has an open task: {number}")
            expect(not has_blocking_divergence, f"concluded slice has blocking divergence: {number}")
            expect("## Diff Summary\n\n- pending" not in task_text, f"concluded slice lacks diff summary: {number}")
            expect("## Final Result\n\n- pending" not in task_text, f"concluded slice lacks final result: {number}")
            evidence = extract_evidence_fields(p_task)
            validate_concluded_test_evidence(evidence, p_task)
            direct_pass = evidence["validation"] == "PASS" and evidence["corrections"] == [] and evidence["revalidation"] == "not_required"
            corrected_pass = evidence["validation"] == "NEEDS_FIX" and bool(evidence["corrections"]) and evidence["revalidation"] == "PASS"
            expect(direct_pass or corrected_pass, f"concluded slice has invalid validation history: {number}")
            if evidence["validation"] == "NEEDS_FIX":
                expect("Problem:" in task_text and "Expected correction:" in task_text, f"findings were not persisted: {number}")
        else:
            expect(row["done"] == "[ ]", f"invalid global progress value: {row['done']}")

    for row in rows:
        if row["done"] == "[x]":
            continue
        for dependency in dependency_numbers(row["dependencies"]):
            dep_row = next(item for item in rows if item["number"] == dependency)
            if row["number"] in eligible_slices(root):
                expect(dep_row["done"] == "[x]", f"eligible slice has incomplete dependency: {row['number']}")

    for number in ["01", "02", "03"]:
        plan_text = plan_path(root, number).read_text(encoding="utf-8")
        if "- Eligible: yes" in plan_text:
            expect("no shared files" in plan_text, f"parallel slice lacks non-overlap justification: {number}")


def invalid_execution(name: str, mutate, expected_message: str | None = None) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / name
        execution_fixture(root)
        mutate(root)
        try:
            check_execution(root)
        except SystemExit as exc:
            if expected_message is not None:
                expect(expected_message in str(exc), f"invalid execution fixture {name} failed for wrong reason: {exc}")
            return
        fail(f"invalid execution fixture accepted: {name}")


def replace_task_text(root: Path, number: str, old: str, new: str) -> None:
    path = task_path(root, number)
    text = path.read_text(encoding="utf-8")
    expect(old in text, f"fixture text is missing {old!r}: {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def check_validation_history_matrix(base: Path) -> None:
    for validation in ["pending", "PASS", "NEEDS_FIX"]:
        for corrections in [[], ["fix"]]:
            for revalidation in ["pending", "PASS", "NEEDS_FIX", "not_required"]:
                root = base / f"validation-{validation}-{'with' if corrections else 'without'}-corrections-{revalidation}"
                execution_fixture(root)
                conclude_slice(root, validation=validation, corrections=corrections, revalidation=revalidation)
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
                expect(accepted == expected, f"validation-history matrix mismatch: {root.name}")


def check_divergence_matrix(base: Path) -> None:
    cases = [
        ("none-valid", "- nenhuma", False, True),
        ("blocking-valid", "- Tipo: escopo\n  - Descrição: Fixture divergence.\n  - Impacto: Fixture blocked.\n  - Decisão necessária: Resolve fixture scope.\n  - Bloqueante: sim", True, True),
        ("nonblocking-valid", "- Tipo: observação\n  - Descrição: Fixture divergence.\n  - Impacto: No block.\n  - Decisão necessária: Track later.\n  - Bloqueante: não", False, True),
        ("missing-bloqueante", "- Tipo: escopo\n  - Descrição: Fixture divergence.\n  - Impacto: Fixture blocked.\n  - Decisão necessária: Resolve fixture scope.", None, False),
        ("invalid-bloqueante", "- Tipo: escopo\n  - Descrição: Fixture divergence.\n  - Impacto: Fixture blocked.\n  - Decisão necessária: Resolve fixture scope.\n  - Bloqueante: talvez", None, False),
        ("mixed-none", "- nenhuma\n- Tipo: escopo\n  - Descrição: Fixture divergence.\n  - Impacto: Fixture blocked.\n  - Decisão necessária: Resolve fixture scope.\n  - Bloqueante: sim", None, False),
    ]
    for name, body, expected_blocking, should_accept in cases:
        root = base / f"divergence-{name}"
        execution_fixture(root)
        replace_section(task_path(root, "01"), "Divergências", body)
        try:
            actual = has_divergencia_bloqueante(task_path(root, "01"))
        except SystemExit:
            accepted = False
            actual = None
        else:
            accepted = True
        expect(accepted == should_accept, f"divergence matrix acceptance mismatch: {name}")
        if should_accept:
            expect(actual == expected_blocking, f"divergence blocking mismatch: {name}")
    invalid_execution("missing-divergence-section", lambda root: replace_task_text(root, "01", "## Divergências\n\n- nenhuma\n\n", ""), "expected exactly one Divergências section")
    invalid_execution("duplicate-divergence-section", lambda root: replace_task_text(root, "01", "## Execution Evidence", "## Divergências\n\n- nenhuma\n\n## Execution Evidence"), "expected exactly one Divergências section")
    invalid_execution("eligible-malformed-divergence", lambda root: replace_section(task_path(root, "01"), "Divergências", "- Tipo: escopo\n  - Descrição: missing blocking flag\n  - Impacto: ambiguous\n  - Decisão necessária: decide"), "missing divergence field Bloqueante")
    invalid_execution("dependency-blocked-malformed-divergence", lambda root: replace_section(task_path(root, "03"), "Divergências", "- Tipo: escopo\n  - Descrição: malformed future slice divergence\n  - Impacto: ambiguous\n  - Decisão necessária: decide"), "missing divergence field Bloqueante")


def external_execution_fixture(base: Path) -> None:
    source = base / "requirements/billing-change.md"
    original = "# Billing change\n\nThe billing behavior is observable.\n"
    write(source, original)
    execution = base / "requirements/billing-change-execution"
    write(execution / "plan.md", header("stnl-spec-execution-manager", "External global execution plan") + """# Execution Plan

## Global Context

- Fonte de requisitos: `../billing-change.md`
- Execution root: `.`
- Objetivo geral: Deliver billing behavior.
- Estratégia: One slice.

| Slice | Summary | Dependencies | Covered Requirements | Expected Areas | Parallelization | Detailed Plan |
|---|---|---|---|---|---|---|
| 01 - Billing | Billing behavior becomes observable | - | billing-change.md | billing | no: single slice | plans/slice-01.md |
""")
    write(execution / "plans/slice-01.md", header("stnl-spec-execution-manager", "External detailed slice plan") + """# Slice 01 - Billing

## Referências

- Slice: 01
- Fonte de requisitos: `../../billing-change.md`
""")
    write(execution / "tasks.md", header("stnl-spec-execution-manager", "External global execution tasks") + """# Execution Tasks

| Done | Slice | Delivery | Dependencies | Detail | Tests | Validation | Result |
|---|---|---|---|---|---|---|---|
| [ ] | 01 - Billing | Billing behavior | - | tasks/slice-01.md | pending | pending | - |
""")
    write(execution / "tasks/slice-01.md", header("stnl-spec-execution-manager", "External detailed slice tasks") + """# Slice 01 Tasks - Billing

## Referências

- Slice: 01
- Plano: `../plans/slice-01.md`
- Fonte de requisitos: `../../billing-change.md`
""")
    expect(source.read_text(encoding="utf-8") == original, "external requirements source changed during planning")
    expect("# File Purpose Header" not in source.read_text(encoding="utf-8"), "external requirements source requires a lifecycle header")
    expect(not (base / "requirements/feature_spec.md").exists(), "external requirements source was renamed")
    expect("- Fonte de requisitos: `../billing-change.md`" in (execution / "plan.md").read_text(encoding="utf-8"), "external global plan lacks relative source")
    expect("- Fonte de requisitos: `../../billing-change.md`" in (execution / "plans/slice-01.md").read_text(encoding="utf-8"), "external detailed plan lacks relative source")
    expect("- Fonte de requisitos: `../../billing-change.md`" in (execution / "tasks/slice-01.md").read_text(encoding="utf-8"), "external task lacks relative source")
    expect("- Plano: `../plans/slice-01.md`" in (execution / "tasks/slice-01.md").read_text(encoding="utf-8"), "external task points to wrong plan")
    for path in [execution / "plan.md", execution / "plans/slice-01.md", execution / "tasks.md", execution / "tasks/slice-01.md"]:
        check_header(path, "stnl-spec-execution-manager")


def make_parallel_ready(root: Path) -> None:
    conclude_slice(root, "01")
    tasks = root / "execution/tasks.md"
    text = tasks.read_text(encoding="utf-8")
    text = text.replace("| [ ] | 02 - API | API behavior | 01 |", "| [ ] | 02 - API | API behavior | 01 |")
    text = text.replace("| [ ] | 03 - Maintenance | Maintenance behavior | 02 |", "| [ ] | 03 - Maintenance | Maintenance behavior | 01 |")
    tasks.write_text(text, encoding="utf-8")
    write(plan_path(root, "02"), slice_plan("02", "API", "AC-002", "01", parallel=True))
    write(plan_path(root, "03"), slice_plan("03", "Maintenance", "AC-003", "01", parallel=True))


def static_contract_checks() -> None:
    for root, owner in [(SPEC_ROOT, "stnl-spec-lifecycle-manager"), (EXEC_ROOT, "stnl-spec-execution-manager")]:
        for folder in ["references", "templates", "examples", "evals"]:
            for path in (root / folder).glob("*.md"):
                check_header(path, owner)

    spec_forbidden = re.compile(
        r"plan\.md|tasks\.md|plans/|tasks/|slice-execute|slice-validate|slice-parallel|independent validation|implementation slice",
        re.IGNORECASE,
    )
    for path in SPEC_ROOT.rglob("*.md"):
        expect(spec_forbidden.search(path.read_text(encoding="utf-8")) is None, f"SPEC skill retains execution content: {path}")

    execution_text = "\n".join(path.read_text(encoding="utf-8") for path in EXEC_ROOT.rglob("*.md"))
    expect("must use stnl-spec-lifecycle-manager" not in execution_text.lower(), "execution skill requires SPEC skill")
    expect("required stnl-spec-lifecycle-manager" not in execution_text.lower(), "execution skill requires SPEC skill")
    expect("only specs created by" not in execution_text.lower(), "execution skill requires one source")
    for marker in ["if NEEDS_FIX: APPLY_FINDINGS", "VALIDATE_SLICE as revalidation", "without overwriting the initial validation history"]:
        expect(marker in execution_text, f"execution workflow does not preserve revalidation: {marker}")
    for token in [
        "plans/" + "plan-" + "01.md",
        "tasks/" + "tasks-" + "01.md",
        "ph" + "ase-execute",
        "ph" + "ase-validate",
        "ph" + "ase-finalize",
        "ph" + "ase-commit",
        "ph" + "ase-parallel",
    ]:
        expect(token not in execution_text, f"legacy execution token remains: {token}")
    for token in ["work" + "ers", "coord" + "inator", "Claude" + " Code", "Hai" + "ku", "Son" + "net", "GPT" + "-"]:
        expect(token.lower() not in execution_text.lower(), f"vendor, model, or fixed topology remains: {token}")
    close_policy = (EXEC_ROOT / "references/execution-close-policy.md").read_text(encoding="utf-8")
    for policy in ["validate" + "_only", "validate" + "_and_keep", "validate" + "_and_remove"]:
        expect(policy not in close_policy, f"removed execution closure policy remains: {policy}")
    expect("consolidate" not in execution_text.lower(), "execution skill retains a source-update closure policy")
    expect("CLOSE` validates and reports" in close_policy, "closure contract does not define report-only behavior")
    expect("does not change the requirements source" in close_policy, "closure contract does not protect requirements")
    expect("does not remove execution artifacts" in close_policy, "closure contract does not reject retention/removal policy")


with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)

    active_spec = base / "active-spec"
    spec_fixture(active_spec)
    check_spec_active(active_spec)

    blocked_spec = base / "blocked-spec"
    blocked_spec_fixture(blocked_spec)
    check_spec_blocked(blocked_spec)

    closed_spec = base / "closed-spec"
    closed_spec_fixture(closed_spec)
    check_spec_closed(closed_spec)

    closed_spec_with_execution = base / "closed-spec-with-execution"
    execution_fixture(closed_spec_with_execution)
    execution_snapshot = snapshot_tree(closed_spec_with_execution / "execution")
    check_spec_closed(closed_spec_with_execution)
    expect(snapshot_tree(closed_spec_with_execution / "execution") == execution_snapshot, "documentary CLOSE validation changed the execution workspace")

    invalid_closed_spec = base / "invalid-closed-spec"
    closed_spec_fixture(invalid_closed_spec)
    write(invalid_closed_spec / "shared/questions.md", "Lifecycle residue.\n")
    try:
        check_spec_closed(invalid_closed_spec)
    except (SystemExit, ValidationError):
        pass
    else:
        fail("invalid closed SPEC with shared residue accepted")

    active_execution = base / "active-execution"
    execution_fixture(active_execution)
    check_execution(active_execution)
    expect(eligible_slices(active_execution) == ["01"], "initial eligible-slice discovery is not deterministic")

    after_first = base / "after-first"
    execution_fixture(after_first)
    conclude_slice(after_first, "01")
    check_execution(after_first)
    expect(eligible_slices(after_first) == ["02"], "next eligible-slice discovery is not deterministic")

    parallel_ready = base / "parallel-ready"
    execution_fixture(parallel_ready)
    make_parallel_ready(parallel_ready)
    check_execution(parallel_ready)
    expect(eligible_slices(parallel_ready) == ["02", "03"], "parallel-ready fixture lacks multiple eligible slices")

    external_execution_fixture(base / "external-source")

    invalid_execution("missing-plan", lambda root: plan_path(root, "01").unlink())
    invalid_execution("missing-task-file", lambda root: task_path(root, "03").unlink())
    invalid_execution("wrong-task-plan", lambda root: replace_task_text(root, "01", "../plans/slice-01.md", "../plans/slice-02.md"))
    invalid_execution("wrong-relative-source", lambda root: replace_task_text(root, "01", "- Fonte de requisitos: `../../feature_spec.md`", "- Fonte de requisitos: `../feature_spec.md`"))
    invalid_execution("missing-ac", lambda root: replace_task_text(root, "01", "AC-001", "AC-999"))
    invalid_execution("plan-contains-checkbox", lambda root: (root / "execution/plan.md").write_text((root / "execution/plan.md").read_text(encoding="utf-8") + "\n| [ ] | bad |\n", encoding="utf-8"))
    invalid_execution("completed-open-task", lambda root: update_task_row(root, "01", done="[x]", tests="PASS", validation="PASS", result="Done"))
    invalid_execution("concluded-blocked-divergence", lambda root: (conclude_slice(root, "01"), replace_task_text(root, "01", "- nenhuma", "- Tipo: escopo\n  - Descrição: Fixture divergence.\n  - Impacto: Fixture blocked.\n  - Decisão necessária: Resolve fixture scope.\n  - Bloqueante: sim")))
    invalid_execution("parallel-without-safety", lambda root: (conclude_slice(root, "01"), write(plan_path(root, "02"), slice_plan("02", "API", "AC-002", "01", parallel=True).replace("no shared files, state, contracts, fixtures, generated code, or mutable resources", "not_applicable")), update_task_row(root, "02", done="[ ]", tests="pending", validation="pending", result="-")))
    invalid_execution("pass-without-tests", lambda root: conclude_slice(root, "01", tests_executed=[], test_result="PASS"), "PASS test_result requires at least one tests_executed item")
    invalid_execution("not-applicable-without-reason", lambda root: conclude_slice(root, "01", tests_executed=[], test_result="not_applicable"), "not_applicable test_result requires test_reason")
    invalid_execution("not-applicable-generic-reason", lambda root: conclude_slice(root, "01", tests_executed=[], test_result="not_applicable", test_reason="n/a"), "generic test_reason value")
    invalid_execution("pending-validation", lambda root: conclude_slice(root, "01", validation="pending", revalidation="pending"))
    invalid_execution("needs-fix-without-corrections", lambda root: conclude_slice(root, "01", validation="NEEDS_FIX", revalidation="PASS"))
    invalid_execution("needs-fix-without-revalidation", lambda root: conclude_slice(root, "01", validation="NEEDS_FIX", corrections=["fix"], revalidation="pending"))
    invalid_execution("initial-pass-with-revalidation", lambda root: conclude_slice(root, "01", revalidation="PASS"))
    invalid_execution("missing-evidence-field", lambda root: (conclude_slice(root, "01"), replace_task_text(root, "01", "- Validação: PASS\n", "")))
    invalid_execution("duplicate-evidence-field", lambda root: (conclude_slice(root, "01"), replace_task_text(root, "01", "- Validação: PASS\n", "- Validação: PASS\n- Validação: PASS\n")))
    invalid_execution("malformed-tests-list", lambda root: (conclude_slice(root, "01"), replace_task_text(root, "01", "- Testes executados:\n  - fixture-test-01\n", "- Testes executados:\n  fixture-test-01\n")))
    invalid_execution("inline-filled-tests-list", lambda root: (conclude_slice(root, "01"), replace_task_text(root, "01", "- Testes executados:\n  - fixture-test-01\n", "- Testes executados: [fixture-test-01]\n")))

    not_applicable_pass = base / "not-applicable-pass"
    execution_fixture(not_applicable_pass)
    conclude_slice(not_applicable_pass, "01", tests_executed=[], test_result="not_applicable", test_reason="Documentation-only slice with no executable behavior.")
    check_execution(not_applicable_pass)

    corrected_pass = base / "corrected-pass"
    execution_fixture(corrected_pass)
    conclude_slice(corrected_pass, "01", validation="NEEDS_FIX", corrections=["fix persisted finding"], revalidation="PASS")
    check_execution(corrected_pass)

    check_validation_history_matrix(base)
    check_divergence_matrix(base)
    static_contract_checks()

print("PASS: SPEC workspace structural smoke validation")
print("PASS: slice execution workspace structural smoke validation")
print("PASS: slice evidence and validation-history fixtures")
print("PASS: divergence contract fixtures")
print("PASS: external requirements source structural smoke validation")
print("PASS: slice selective-reading and closure contract checks")
PY

"$PYTHON_BIN" scripts/test-spec-lifecycle.py
