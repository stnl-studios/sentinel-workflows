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


def fail(message: str) -> None:
    raise SystemExit(message)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def file_header(purpose: str, status: str = "draft") -> str:
    return f"""# File Purpose Header

```yaml
purpose: {purpose}
status: {status}
read_when: Needed for structural smoke validation.
do_not_read_when: A narrower artifact is enough.
contains: Smoke fixture content.
owner: stnl-spec-lifecycle-manager
update_policy: Test fixture only.
```

"""


def extract_ids(text: str, prefix: str) -> set[str]:
    return set(re.findall(rf"\b{prefix}-\d{{3}}\b", text))


def validate_modular_workspace(root: Path) -> None:
    for forbidden in ["slice-context.md", "context-package.md"]:
        if (root / forbidden).exists():
            fail(f"persistent context package is invalid: {forbidden}")

    required = [
        root / "feature_spec.md",
        root / "slices/SL-001.md",
        root / "lifecycle/traceability.md",
        root / "lifecycle/qa-checklist.md",
        root / "lifecycle/resume-notes.md",
    ]
    for path in required:
        if not path.exists():
            fail(f"missing required workspace file: {path}")
        if not path.read_text(encoding="utf-8").startswith("# File Purpose Header"):
            fail(f"missing File Purpose Header: {path}")

    feature = (root / "feature_spec.md").read_text(encoding="utf-8")
    if "### AC-001" in feature or "### SL-001" in feature:
        fail("operational feature_spec.md contains monolithic artifact detail")

    slice_path = root / "slices/SL-001.md"
    slice_text = slice_path.read_text(encoding="utf-8")
    if not re.search(r"^# SL-001\b", slice_text, re.MULTILINE):
        fail("slice heading does not match filename")
    if not re.search(r"^id:\s+SL-001$", slice_text, re.MULTILINE):
        fail("slice id field does not match filename")

    for prefix, shared_name, field in [
        ("AC", "acceptance-criteria.md", "linked_acceptance_criteria"),
        ("C", "constraints.md", "linked_constraints"),
        ("R", "risks.md", "linked_risks"),
        ("D", "decisions.md", "linked_decisions"),
    ]:
        linked = extract_ids(re.search(rf"{field}:\s+\[(.*?)\]", slice_text).group(1), prefix)
        if not linked:
            continue
        shared_path = root / "shared" / shared_name
        if not shared_path.exists():
            fail(f"missing shared file for linked IDs: {shared_path}")
        shared_text = shared_path.read_text(encoding="utf-8")
        for linked_id in linked:
            if not re.search(rf"^### {linked_id}\b", shared_text, re.MULTILINE):
                fail(f"linked ID block missing: {linked_id}")


def validate_closed_workspace(root: Path) -> None:
    if not (root / "feature_spec.md").exists():
        fail("closed workspace missing feature_spec.md")
    for name in ["shared", "slices", "lifecycle"]:
        if (root / name).exists():
            fail(f"closed workspace still has operational directory: {name}")


with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)
    valid = base / "valid"
    write(valid / "feature_spec.md", file_header("Operational index") + """
# Fixture - Feature Spec Index

```yaml
spec_status: ready
next_candidate_slice: SL-001
artifacts:
  acceptance_criteria:
    file: shared/acceptance-criteria.md
    count: 1
    materialized: true
  slices:
    - id: SL-001
      file: slices/SL-001.md
      status: ready
```
""")
    write(valid / "shared/acceptance-criteria.md", file_header("ACs") + """
# Acceptance Criteria

### AC-001 - Observable behavior

```yaml
id: AC-001
status: active
statement: The behavior is observable.
linked_slices: [SL-001]
```
""")
    write(valid / "shared/constraints.md", file_header("Constraints") + """
# Constraints

### C-001 - Keep contract

```yaml
id: C-001
status: active
constraint: Keep the public contract stable.
linked_artifacts: [SL-001]
```
""")
    write(valid / "shared/risks.md", file_header("Risks") + """
# Risks

### R-001 - Drift

```yaml
id: R-001
status: open
risk: Implementation drift.
impact: medium
mitigation: Validate AC links.
linked_artifacts: [SL-001]
```
""")
    write(valid / "shared/decisions.md", file_header("Decisions") + """
# Decisions

### D-001 - Stable path

```yaml
id: D-001
status: accepted
decision: Use the stable path.
linked_artifacts: [SL-001]
```
""")
    write(valid / "slices/SL-001.md", file_header("Slice") + """
# SL-001 - Fixture slice

```yaml
id: SL-001
status: ready
goal: Validate structure.
scope: Smoke fixture.
out_of_scope: Runtime behavior.
linked_acceptance_criteria: [AC-001]
linked_decisions: [D-001]
linked_constraints: [C-001]
linked_risks: [R-001]
linked_questions: []
dependencies: []
validation_hints:
  - Observable smoke validation.
context_hints:
  - fixture
slice_readiness:
  status: ready
  blockers: []
  missing: []
completion_summary: null
```
""")
    write(valid / "lifecycle/traceability.md", file_header("Traceability") + "| Slice | Slice file | ACs | Constraints | Risks | Decisions | Questions |\n|---|---|---|---|---|---|---|\n| `SL-001` | `slices/SL-001.md` | `AC-001` | `C-001` | `R-001` | `D-001` | - |\n")
    write(valid / "lifecycle/qa-checklist.md", file_header("QA") + "```yaml\nqa_checklist:\n  spec_quality_gate:\n    status: ready\n```\n")
    write(valid / "lifecycle/resume-notes.md", file_header("Resume") + "```yaml\nnext_candidate_slice: SL-001\n```\n")
    validate_modular_workspace(valid)

    monolithic = base / "monolithic"
    write(monolithic / "feature_spec.md", file_header("Bad monolith") + "### AC-001 - Embedded AC\n### SL-001 - Embedded slice\n")
    try:
        validate_modular_workspace(monolithic)
    except SystemExit:
        pass
    else:
        fail("monolithic operational spec fixture should be invalid")

    invalid_package = base / "invalid-package"
    for source in valid.rglob("*"):
        if source.is_file():
            write(invalid_package / source.relative_to(valid), source.read_text(encoding="utf-8"))
    write(invalid_package / "context-package.md", "invalid persistent context package\n")
    try:
        validate_modular_workspace(invalid_package)
    except SystemExit:
        pass
    else:
        fail("persistent context package fixture should be invalid")

    closed = base / "closed"
    write(closed / "feature_spec.md", file_header("Closed spec", "closed") + "# Closed fixture\n")
    validate_closed_workspace(closed)

print("PASS: structural smoke validation")
PY
