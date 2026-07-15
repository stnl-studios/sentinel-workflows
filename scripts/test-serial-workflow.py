#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


IGNORED = {".DS_Store", "__MACOSX"}
REMOVED = "REMOVED"


def expect(value: bool, message: str) -> None:
    if not value:
        raise AssertionError(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ignored(path: Path) -> bool:
    return path.name in IGNORED or path.name.startswith("._") or "__MACOSX" in path.parts


def snapshot(root: Path) -> dict[str, bytes]:
    if not root.exists():
        return {}
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


PRISTINE_TASK = """# Slice Tasks

## Checklist

- [ ] 1.1 task

## Changed Areas

- pending

## Scope Expansion

- none

## Prior Validation Overlap

- none

## Divergences

- none

## Developer Checks

- none

## Validation Attempts

- none

## Validation Findings

- none

## Corrections Applied

- none

## Effective Validation Base

- none

## Diff Summary

- pending

## Final Result

- pending
"""


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def create_plans(root: Path, approved: bool = True, count: int = 1) -> None:
    state = "ready" if approved else "draft"
    review = "approved" if approved else "pending"
    rows = []
    for number in range(1, count + 1):
        rows.append(f"| {number:02d} | plans/slice-{number:02d}.md |")
        write(
            root / f"plans/slice-{number:02d}.md",
            f"# File Purpose Header\nstatus: {state}\n\n- Review state: {review}\n",
        )
    write(
        root / "plan.md",
        f"# File Purpose Header\nstatus: {state}\n\n- Review state: {review}\n" + "\n".join(rows) + "\n",
    )


def materialize(root: Path, count: int = 1) -> None:
    plan = (root / "plan.md").read_text(encoding="utf-8")
    details = [root / f"plans/slice-{number:02d}.md" for number in range(1, count + 1)]
    expect("status: ready" in plan and "Review state: approved" in plan, "draft global plan accepted")
    expect(all(path.exists() for path in details), "missing detailed plan accepted")
    expect(
        all("status: ready" in path.read_text(encoding="utf-8") and "Review state: approved" in path.read_text(encoding="utf-8") for path in details),
        "draft detailed plan accepted",
    )
    expect(not (root / "tasks.md").exists(), "existing tasks.md accepted")
    expect(not any((root / "tasks").glob("slice-*.md")) if (root / "tasks").exists() else True, "existing task detail accepted")
    rendered = {root / f"tasks/slice-{number:02d}.md": PRISTINE_TASK for number in range(1, count + 1)}
    rows = [f"| [ ] | {number:02d} | tasks/slice-{number:02d}.md | pending | pending |" for number in range(1, count + 1)]
    rendered[root / "tasks.md"] = "# Execution Tasks\n\n" + "\n".join(rows) + "\n"
    for path, text in rendered.items():
        write(path, text)


def section(text: str, heading: str) -> str:
    marker = f"## {heading}\n"
    expect(marker in text, f"missing section {heading}")
    body = text.split(marker, 1)[1]
    return body.split("\n## ", 1)[0].strip()


def derive_state(root: Path) -> str:
    if not root.exists() or not any(not ignored(path) for path in root.iterdir()):
        return "empty"
    plan = root / "plan.md"
    plans = sorted((root / "plans").glob("slice-*.md")) if (root / "plans").is_dir() else []
    tasks_index = root / "tasks.md"
    tasks = sorted((root / "tasks").glob("slice-*.md")) if (root / "tasks").is_dir() else []
    if plan.exists() and plans and not tasks_index.exists() and not tasks:
        return "planned"
    if not (plan.exists() and plans and tasks_index.exists() and tasks):
        return "invalid"
    index = tasks_index.read_text(encoding="utf-8")
    pristine = "| [x] |" not in index and all("| pending | pending |" in line for line in index.splitlines() if line.startswith("| ["))
    complete = bool(tasks) and all("| [x] |" in line and line.endswith("| PASS | PASS |") for line in index.splitlines() if line.startswith("| ["))
    for task in tasks:
        text = task.read_text(encoding="utf-8")
        pristine = pristine and "- [x]" not in section(text, "Checklist")
        for name, sentinel in {
            "Changed Areas": "- pending",
            "Scope Expansion": "- none",
            "Prior Validation Overlap": "- none",
            "Divergences": "- none",
            "Developer Checks": "- none",
            "Validation Attempts": "- none",
            "Validation Findings": "- none",
            "Corrections Applied": "- none",
            "Effective Validation Base": "- none",
            "Diff Summary": "- pending",
            "Final Result": "- pending",
        }.items():
            pristine = pristine and section(text, name) == sentinel
        complete = complete and section(text, "Final Result").startswith("- PASS") and section(text, "Effective Validation Base") != "- none"
    if complete:
        return "complete"
    return "materialized-pristine" if pristine else "execution-started"


def gated(root: Path, allowed: str, action: Callable[[], None]) -> bool:
    before = snapshot(root)
    if derive_state(root) != allowed:
        expect(snapshot(root) == before, "blocked gate changed bytes")
        return False
    action()
    return True


@dataclass
class Attempt:
    identifier: str
    kind: str
    status: str
    head: str = "fixture-head"
    scope: str = "slice scope"
    commands: list[tuple[str, int]] = field(default_factory=lambda: [("fixture-test", 0)])
    evidence: str = "objective evidence"
    findings: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    effects: list[str] = field(default_factory=list)
    summary: str = "compact summary"
    historical_hashes: dict[str, str] = field(default_factory=dict)


@dataclass
class Base:
    origin: str
    kind: str
    head: str
    result: str
    files: list[tuple[str, str]]
    commands: list[tuple[str, int]]
    evidence: str


@dataclass
class Slice:
    number: int
    required_paths: set[str]
    checklist_done: bool = True
    changed_paths: set[str] = field(default_factory=set)
    overlap_paths: set[str] = field(default_factory=set)
    regression_paths: set[str] = field(default_factory=set)
    findings: list[str] = field(default_factory=list)
    corrections: set[str] = field(default_factory=set)
    divergences: list[str] = field(default_factory=list)
    attempts: list[Attempt] = field(default_factory=list)
    bases: list[Base] = field(default_factory=list)
    done: bool = False
    final_result: str = "pending"


@dataclass
class Workflow:
    slices: list[Slice]
    files: dict[str, bytes]

    def validate(
        self,
        item: Slice,
        status: str,
        manifest: list[tuple[str, str]] | None = None,
        *,
        finding: str = "fixture finding",
        blocker: str = "fixture blocker",
        historical_hashes: dict[str, str] | None = None,
    ) -> None:
        expect(item.checklist_done and not item.done and not item.divergences, "invalid validation prerequisites accepted")
        identifier = f"attempt-{len(item.attempts) + 1:02d}"
        kind = "initial" if not item.attempts else "revalidation"
        attempt = Attempt(identifier, kind, status, historical_hashes=historical_hashes or {})
        if status == "NEEDS_FIX":
            attempt.findings.append(finding)
            item.findings.append(finding)
        elif status == "BLOCKED":
            attempt.blockers.append(blocker)
        else:
            expect(status == "PASS", "unknown status accepted")
        item.attempts.append(attempt)
        if status != "PASS":
            expect(not item.done and item.final_result == "pending", "non-PASS completed slice")
            return
        try:
            expect(manifest is not None and manifest, "PASS without manifest")
            paths = [path for path, _ in manifest]
            expect(paths == sorted(paths) and len(paths) == len(set(paths)), "duplicate or unsorted manifest")
            required = item.required_paths | item.changed_paths | item.corrections | item.overlap_paths
            expect(required <= set(paths), "incomplete final manifest")
            expect(item.overlap_paths <= item.regression_paths, "overlap lacks justified regression")
            for path, value in manifest:
                expect(not path.startswith("/") and ".." not in Path(path).parts, "invalid manifest path")
                if value == REMOVED:
                    expect(path not in self.files, "REMOVED path is present")
                else:
                    expect(len(value) == 64 and value == value.lower() and all(c in "0123456789abcdef" for c in value), "malformed hash")
                    expect(path in self.files and sha(self.files[path]) == value, "manifest differs from workspace")
            expect(all(code == 0 for _, code in attempt.commands), "nonzero authoritative command")
        except AssertionError as error:
            attempt.status = "BLOCKED"
            attempt.blockers.append(str(error))
            return
        item.bases = [Base(identifier, kind, attempt.head, "PASS", list(manifest), list(attempt.commands), attempt.evidence)]
        item.done = True
        item.final_result = "PASS"

    def close(self) -> tuple[bool, list[str]]:
        errors: list[str] = []
        ownership: dict[str, tuple[int, str]] = {}
        claimed_changes: set[str] = set()
        for item in self.slices:
            claimed_changes |= item.changed_paths | item.corrections
            if not item.done or item.final_result != "PASS":
                errors.append(f"slice-{item.number:02d}: incomplete")
                continue
            if len(item.bases) != 1:
                errors.append(f"slice-{item.number:02d}: requires exactly one Effective Validation Base")
                continue
            base = item.bases[0]
            origins = [attempt for attempt in item.attempts if attempt.identifier == base.origin]
            if len(origins) != 1 or origins[0].status != "PASS" or base.result != "PASS":
                errors.append(f"slice-{item.number:02d}: invalid base origin")
                continue
            paths = [path for path, _ in base.files]
            if paths != sorted(paths) or len(paths) != len(set(paths)):
                errors.append(f"slice-{item.number:02d}: contradictory base manifest")
                continue
            for path, expected in base.files:
                ownership[path] = (item.number, expected)
        for path in sorted(claimed_changes - ownership.keys()):
            errors.append(f"{path}: no final validation owner")
        for path, (owner, expected) in sorted(ownership.items()):
            current = REMOVED if path not in self.files else sha(self.files[path])
            if current != expected:
                errors.append(f"{path}: slice-{owner:02d}; expected {expected}; current {current}; run explicit VALIDATE_SLICE")
        return not errors, errors


def manifest(workflow: Workflow, *paths: str) -> list[tuple[str, str]]:
    return [(path, REMOVED if path not in workflow.files else sha(workflow.files[path])) for path in sorted(paths)]


def validation_scenarios() -> None:
    direct = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    direct.validate(direct.slices[0], "PASS", manifest(direct, "src/a.txt"))
    expect(direct.slices[0].attempts[0].identifier == "attempt-01" and len(direct.slices[0].bases) == 1 and direct.slices[0].done, "direct PASS failed")

    needs_fix = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"bad"})
    needs_fix.validate(needs_fix.slices[0], "NEEDS_FIX")
    expect(needs_fix.slices[0].findings and not needs_fix.slices[0].bases and not needs_fix.slices[0].done, "NEEDS_FIX authority failed")

    blocked = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    blocked.validate(blocked.slices[0], "BLOCKED")
    expect(blocked.slices[0].attempts[0].blockers and not blocked.slices[0].bases and not blocked.slices[0].done, "BLOCKED authority failed")

    findings = Workflow([Slice(1, {"src/a.txt", "tests/a.txt"}, changed_paths={"src/a.txt", "tests/a.txt"})], {"src/a.txt": b"bad", "tests/a.txt": b"test"})
    item = findings.slices[0]
    findings.validate(item, "NEEDS_FIX", historical_hashes={"src/a.txt": sha(b"bad")})
    findings.files["src/a.txt"] = b"fixed"
    item.corrections.add("src/a.txt")
    findings.validate(item, "PASS", manifest(findings, "src/a.txt", "tests/a.txt"))
    ok, errors = findings.close()
    expect(ok and not errors and [a.identifier for a in item.attempts] == ["attempt-01", "attempt-02"] and item.bases[0].origin == "attempt-02", "NEEDS_FIX -> APPLY_FINDINGS -> revalidation PASS -> CLOSE PASS failed")

    repeated = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"v1"})
    item = repeated.slices[0]
    repeated.validate(item, "NEEDS_FIX")
    repeated.validate(item, "NEEDS_FIX")
    repeated.files["src/a.txt"] = b"v3"
    item.corrections.add("src/a.txt")
    repeated.validate(item, "PASS", manifest(repeated, "src/a.txt"))
    expect([a.identifier for a in item.attempts] == ["attempt-01", "attempt-02", "attempt-03"] and item.bases[0].origin == "attempt-03", "multiple findings cycles failed")

    blocked_then_pass = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    item = blocked_then_pass.slices[0]
    blocked_then_pass.validate(item, "BLOCKED")
    blocked_then_pass.validate(item, "PASS", manifest(blocked_then_pass, "src/a.txt"))
    expect(item.attempts[0].status == "BLOCKED" and item.bases[0].origin == "attempt-02", "BLOCKED history was not preserved")

    drift = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    drift.validate(drift.slices[0], "PASS", manifest(drift, "src/a.txt"))
    drift.files["src/a.txt"] = b"after"
    expect(not drift.close()[0], "real drift accepted")

    shared = Workflow(
        [Slice(1, {"src/shared.txt"}, changed_paths={"src/shared.txt"}), Slice(2, {"src/shared.txt"}, changed_paths={"src/shared.txt"}, overlap_paths={"src/shared.txt"}, regression_paths={"src/shared.txt"})],
        {"src/shared.txt": b"v1"},
    )
    shared.validate(shared.slices[0], "PASS", manifest(shared, "src/shared.txt"))
    shared.files["src/shared.txt"] = b"v2"
    shared.validate(shared.slices[1], "PASS", manifest(shared, "src/shared.txt"))
    expect(shared.close()[0], "later slice final ownership failed")

    omitted = Workflow(
        [Slice(1, {"src/shared.txt"}, changed_paths={"src/shared.txt"}), Slice(2, set(), changed_paths={"src/shared.txt"})],
        {"src/shared.txt": b"v1", "src/b.txt": b"b"},
    )
    omitted.validate(omitted.slices[0], "PASS", manifest(omitted, "src/shared.txt"))
    omitted.files["src/shared.txt"] = b"v2"
    omitted.validate(omitted.slices[1], "PASS", [("src/b.txt", sha(b"b"))])
    expect(not omitted.slices[1].done, "incomplete later manifest accepted")
    omitted.slices[1].done = True
    omitted.slices[1].final_result = "PASS"
    omitted.slices[1].attempts[-1].status = "PASS"
    omitted.slices[1].bases = [Base(omitted.slices[1].attempts[-1].identifier, "initial", "head", "PASS", [("src/b.txt", sha(b"b"))], [("test", 0)], "evidence")]
    expect(not omitted.close()[0], "later changed path omitted from base accepted")

    unowned = Workflow([Slice(1, set(), changed_paths={"src/unowned.txt"})], {"src/unowned.txt": b"x", "src/owned.txt": b"y"})
    unowned.slices[0].attempts = [Attempt("attempt-01", "initial", "PASS")]
    unowned.slices[0].bases = [Base("attempt-01", "initial", "head", "PASS", [("src/owned.txt", sha(b"y"))], [("test", 0)], "evidence")]
    unowned.slices[0].done = True
    unowned.slices[0].final_result = "PASS"
    expect(not unowned.close()[0], "unowned final change accepted")

    removed = Workflow([Slice(1, {"src/deleted.txt"}, changed_paths={"src/deleted.txt"})], {})
    removed.validate(removed.slices[0], "PASS", manifest(removed, "src/deleted.txt"))
    expect(removed.close()[0], "validated removal rejected")
    removed.files["src/deleted.txt"] = b"reappeared"
    expect(not removed.close()[0], "unvalidated reappearance accepted")

    historical = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"final"})
    item = historical.slices[0]
    historical.validate(item, "NEEDS_FIX", historical_hashes={"src/a.txt": sha(b"old")})
    historical.validate(item, "PASS", manifest(historical, "src/a.txt"))
    expect(historical.close()[0], "historical NEEDS_FIX hash caused false drift")

    invalid = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    item = invalid.slices[0]
    invalid.validate(item, "PASS", [("src/a.txt", "bad")])
    expect(item.attempts[-1].status == "BLOCKED" and not item.bases and not item.done, "malformed PASS base accepted")


def state_gate_scenarios() -> None:
    with tempfile.TemporaryDirectory(prefix="stnl-serial-gates-") as tmp:
        base = Path(tmp)
        empty = base / "empty"
        write(empty / ".DS_Store", "ignored")
        write(empty / "__MACOSX/._junk", "ignored")
        expect(derive_state(empty) == "empty", "metadata counted as execution state")
        expect(gated(empty, "empty", lambda: create_plans(empty)), "PLAN in empty root blocked")

        existing_plan = base / "existing-plan"
        create_plans(existing_plan)
        before = snapshot(existing_plan)
        expect(not gated(existing_plan, "empty", lambda: create_plans(existing_plan)), "PLAN replaced existing plan")
        expect(snapshot(existing_plan) == before, "blocked PLAN changed plan bytes")

        existing_tasks = base / "existing-tasks"
        create_plans(existing_tasks)
        materialize(existing_tasks)
        before = snapshot(existing_tasks)
        expect(not gated(existing_tasks, "empty", lambda: create_plans(existing_tasks)), "PLAN replaced tasks")
        expect(snapshot(existing_tasks) == before, "blocked PLAN changed task bytes")

        review = base / "review-plan"
        create_plans(review, approved=False)
        expect(gated(review, "planned", lambda: create_plans(review, approved=True)), "REVIEW_PLAN before tasks blocked")
        materialize(review)
        before = snapshot(review)
        expect(not gated(review, "planned", lambda: create_plans(review)), "REVIEW_PLAN after tasks accepted")
        expect(snapshot(review) == before, "blocked REVIEW_PLAN changed bytes")

        draft = base / "draft"
        create_plans(draft, approved=False)
        before = snapshot(draft)
        try:
            materialize(draft)
        except AssertionError:
            pass
        else:
            raise AssertionError("draft plan materialized")
        expect(snapshot(draft) == before, "draft materialization left partial files")

        existing = base / "materialized"
        create_plans(existing)
        materialize(existing)
        before = snapshot(existing)
        try:
            materialize(existing)
        except AssertionError:
            pass
        else:
            raise AssertionError("existing tasks rematerialized")
        expect(snapshot(existing) == before, "blocked materializer changed bytes")

        pristine = base / "pristine"
        create_plans(pristine)
        materialize(pristine)
        expect(gated(pristine, "materialized-pristine", lambda: None), "pristine task review blocked")

        for name, old, new in [
            ("marked-task", "- [ ] 1.1", "- [x] 1.1"),
            ("developer-check", "## Developer Checks\n\n- none", "## Developer Checks\n\n- unit check exit:0"),
            ("validation-attempt", "## Validation Attempts\n\n- none", "## Validation Attempts\n\n### attempt-01\n\n- Status: BLOCKED"),
        ]:
            root = base / name
            create_plans(root)
            materialize(root)
            task = root / "tasks/slice-01.md"
            task.write_text(task.read_text(encoding="utf-8").replace(old, new), encoding="utf-8")
            before = snapshot(root)
            expect(not gated(root, "materialized-pristine", lambda: write(task, PRISTINE_TASK)), f"REVIEW_TASKS accepted {name}")
            expect(snapshot(root) == before, f"blocked REVIEW_TASKS changed {name}")


def contract_mutation_scenarios() -> None:
    paths = {
        "planner": Path("skills/stnl-execution-planner/SKILL.md"),
        "plan_reviewer": Path("skills/stnl-plan-reviewer/SKILL.md"),
        "materializer": Path("skills/stnl-task-materializer/SKILL.md"),
        "task_reviewer": Path("skills/stnl-task-reviewer/SKILL.md"),
        "quality": Path("skills/stnl-slice-quality-manager/SKILL.md"),
        "base": Path("skills/stnl-slice-quality-manager/references/validation-base.md"),
        "closer": Path("skills/stnl-execution-closer/SKILL.md"),
        "template": Path("skills/stnl-task-materializer/templates/slice-tasks.template.md"),
    }
    canonical = {name: path.read_text(encoding="utf-8") for name, path in paths.items()}
    required = {
        "planner": ["allowed only when the root is absent or contains no other entries", "Reset is a separate explicit user action"],
        "plan_reviewer": ["Run only in `planned`", "preserve all plans byte-for-byte"],
        "materializer": ["Any task artifact", "Validate every precondition and render the full task set before publishing"],
        "task_reviewer": ["Run only in `materialized-pristine`", "preserve all plans and tasks byte-for-byte"],
        "quality": ["append exactly one deterministic next `attempt-NN`", "Effective Validation Base unchanged or absent", "origin is `NEEDS_FIX` or `BLOCKED`", "A `[x]` slice has exactly one valid Effective Validation Base"],
        "base": ["At most one Effective Validation Base", "Paths are relative, unique", "malformed hashes", "origin attempt that is not the current `PASS`"],
        "closer": ["Earlier hashes remain historical and are never compared", "Do not inspect hashes stored inside Validation Attempts", "Do not run tests", "Do not edit, test, invoke a runner"],
        "template": ["## Validation Attempts", "## Effective Validation Base", "Result: PASS"],
    }

    def check(texts: dict[str, str]) -> None:
        for name, markers in required.items():
            for marker in markers:
                expect(marker in texts[name], f"missing contract marker {name}: {marker}")
        joined = "\n".join(texts.values())
        for forbidden in [
            "create or replace the planning artifacts",
            "create or replace task artifacts",
            "PLAN resets execution root",
            "PARALLELIZE_SLICES",
            "FINALIZE_SLICE",
            "## Validation History",
            "## Validation Base\n",
            "Recalculate SHA-256 for every path in each validation base",
        ]:
            expect(forbidden not in joined, f"forbidden contract accepted: {forbidden}")

    check(canonical)
    mutations = [
        ("multiple-effective-bases", "base", "At most one Effective Validation Base", "Multiple Effective Validation Bases may exist"),
        ("base-from-needs-fix", "quality", "origin is `NEEDS_FIX` or `BLOCKED`", "origin is `BLOCKED`"),
        ("base-from-blocked", "quality", "origin is `NEEDS_FIX` or `BLOCKED`", "origin is `NEEDS_FIX`"),
        ("completed-without-base", "quality", "A `[x]` slice has exactly one valid Effective Validation Base", "A `[x]` slice may omit its base"),
        ("duplicate-manifest", "base", "Paths are relative, unique", "Paths are relative"),
        ("malformed-hash", "base", "malformed hashes", "missing hashes"),
        ("materializer-replace", "materializer", "## MATERIALIZE_TASKS", "create or replace task artifacts\n\n## MATERIALIZE_TASKS"),
        ("planner-reset", "planner", "## PLAN", "PLAN resets execution root\n\n## PLAN"),
        ("reviewer-after-tasks", "plan_reviewer", "preserve all plans byte-for-byte", "rewrite plans after tasks"),
        ("task-reviewer-after-start", "task_reviewer", "preserve all plans and tasks byte-for-byte", "rewrite executed tasks"),
        ("closer-historical-hashes", "closer", "## CLOSE", "Recalculate SHA-256 for every path in each validation base\n\n## CLOSE"),
        ("closer-runs-tests", "closer", "Do not run tests", "Run tests"),
        ("closer-calls-runner", "closer", "Do not edit, test, invoke a runner", "Invoke a runner"),
        ("blocked-promotion", "quality", "origin is `NEEDS_FIX` or `BLOCKED`", "promote `BLOCKED` to PASS"),
        ("legacy-validation-contract", "template", "## Validation Attempts", "## Validation History"),
        ("parallel-residue", "planner", "## PLAN", "PARALLELIZE_SLICES\n\n## PLAN"),
    ]
    for label, name, old, new in mutations:
        expect(old in canonical[name], f"missing mutation source: {label}")
        mutated = dict(canonical)
        mutated[name] = mutated[name].replace(old, new, 1)
        try:
            check(mutated)
        except AssertionError:
            continue
        raise AssertionError(f"negative mutation accepted: {label}")


def main() -> None:
    validation_scenarios()
    state_gate_scenarios()
    contract_mutation_scenarios()
    print("PASS: direct PASS, NEEDS_FIX, BLOCKED, findings revalidation, and multiple attempts")
    print("PASS: explicit NEEDS_FIX -> APPLY_FINDINGS -> revalidation PASS -> CLOSE PASS")
    print("PASS: drift, removals, historical hashes, and serial final validation ownership")
    print("PASS: explicit slice-01 shared PASS -> slice-02 shared PASS -> CLOSE PASS")
    print("PASS: PLAN, REVIEW_PLAN, MATERIALIZE_TASKS, and REVIEW_TASKS monotonic state gates")
    print("PASS: blocked operations preserve bytes and leave no partial task set")
    print("PASS: 16 focused negative execution-contract mutations rejected")


if __name__ == "__main__":
    main()
