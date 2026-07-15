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

## Implementation Test Evidence

- none

## Findings Test Evidence

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
            "Implementation Test Evidence": "- none",
            "Findings Test Evidence": "- none",
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
    reviewed_test_evidence: bool = False
    stale_test_evidence: bool = False
    reviewed_non_applicability: bool = False


@dataclass
class TestEvidence:
    identifier: str
    operation: str
    status: str
    tested_state: dict[str, str]
    commands: list[tuple[str, int]]
    automatic_round: int
    automatic_limit: int = 3
    scope: str = "changed scope"
    discovery_sources: list[str] = field(default_factory=lambda: ["project scripts", "development docs", "CI", "nearby tests"])
    verification_types: list[str] = field(default_factory=lambda: ["focused tests", "static validator"])
    non_applicability_rationale: str = "not_applicable"
    no_verification_command_confirmation: str = "not_applicable"
    selected_tests: list[str] = field(default_factory=lambda: ["focused fixture test"])
    rationale: str = "covers changed behavior"
    coverage: str = "changed behavior"
    findings_cycle: str | None = None
    findings_verified: list[str] = field(default_factory=list)
    corrections_covered: set[str] = field(default_factory=set)
    regressions: list[str] = field(default_factory=list)
    unsupported_findings: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    effects: list[str] = field(default_factory=list)
    summary: str = "compact check evidence"
    failures: list[str] = field(default_factory=list)
    previous_failure: str = "none"
    correction_applied: str = "none"
    files_changed_between_rounds: set[str] = field(default_factory=set)
    updated_scope_rationale: str = "not_applicable"


@dataclass
class CheckCorrection:
    operation: str
    failed_check: str
    failure: str
    evidence: str
    change: str
    files: set[str]
    updated_scope: set[str]
    in_scope_rationale: str


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
    implementation_evidence: list[TestEvidence] = field(default_factory=list)
    findings_evidence: list[TestEvidence] = field(default_factory=list)
    check_corrections: list[CheckCorrection] = field(default_factory=list)
    attempts: list[Attempt] = field(default_factory=list)
    bases: list[Base] = field(default_factory=list)
    done: bool = False
    final_result: str = "pending"


@dataclass
class Workflow:
    slices: list[Slice]
    files: dict[str, bytes]
    runner_calls: int = 0
    discovery_actions: int = 0
    verification_commands: int = 0

    def run_checks(
        self,
        item: Slice,
        operation: str,
        status: str,
        paths: set[str],
        *,
        automatic_round: int = 1,
        findings_cycle: str | None = None,
        prior_correction: CheckCorrection | None = None,
    ) -> TestEvidence:
        expect(operation in {"EXECUTE_SLICE", "APPLY_FINDINGS"}, "unsupported check operation accepted")
        expect(status in {"TESTS_PASS", "TESTS_FAIL", "TESTS_NOT_APPLICABLE", "BLOCKED"}, "formal or unknown check status accepted")
        expect(1 <= automatic_round <= 3, "automatic check round exceeded 3")
        expect(not item.done, "checks ran for concluded slice")
        if operation == "APPLY_FINDINGS":
            expect(item.findings and findings_cycle, "findings checks without persisted findings accepted")

        attempt_count = len(item.attempts)
        base_count = len(item.bases)
        self.runner_calls += 1
        self.discovery_actions += 1
        if status == "TESTS_PASS":
            commands = [("fixture-focused-check", 0)]
        elif status == "TESTS_FAIL":
            commands = [("fixture-focused-check", 1)]
        else:
            commands = []
        self.verification_commands += len(commands)
        tested_state = {
            path: REMOVED if path not in self.files else sha(self.files[path])
            for path in sorted(paths)
        }
        collection = item.implementation_evidence if operation == "EXECUTE_SLICE" else item.findings_evidence
        prefix = "implementation-check" if operation == "EXECUTE_SLICE" else "findings-check"
        evidence = TestEvidence(
            identifier=f"{prefix}-{len(collection) + 1:02d}",
            operation=operation,
            status=status,
            tested_state=tested_state,
            commands=commands,
            automatic_round=automatic_round,
            findings_cycle=findings_cycle,
        )
        if status == "TESTS_NOT_APPLICABLE":
            evidence.non_applicability_rationale = "documentation-only scope has no observable executable validator"
            evidence.no_verification_command_confirmation = "no verification command executed"
            expect(evidence.discovery_sources and evidence.verification_types and not evidence.commands, "invalid TESTS_NOT_APPLICABLE evidence")
        if status == "TESTS_FAIL":
            evidence.failures.append("fixture-focused-check failed with exit 1")
        if prior_correction:
            evidence.previous_failure = prior_correction.failure
            evidence.correction_applied = prior_correction.change
            evidence.files_changed_between_rounds = set(prior_correction.files)
            evidence.updated_scope_rationale = prior_correction.in_scope_rationale
            evidence.corrections_covered = set(prior_correction.files)
        if status == "BLOCKED":
            evidence.blockers.append("applicable check discovered but required fixture tool is unavailable")
        if operation == "APPLY_FINDINGS":
            evidence.findings_verified = list(item.findings) if status == "TESTS_PASS" else []
            evidence.corrections_covered = set(item.corrections)
            evidence.regressions = ["related fixture regression"]
            evidence.unsupported_findings = [] if status == "TESTS_PASS" else list(item.findings)
        collection.append(evidence)

        expect(len(item.attempts) == attempt_count, "checks created a Validation Attempt")
        expect(len(item.bases) == base_count and not item.done and item.final_result == "pending", "checks promoted slice authority")
        return evidence

    def run_check_cycle(
        self,
        item: Slice,
        operation: str,
        statuses: list[str],
        paths: set[str],
        *,
        correction_updates: list[dict[str, bytes | None]] | None = None,
        findings_cycle: str | None = None,
    ) -> list[TestEvidence]:
        expect(1 <= len(statuses) <= 3, "manual operation allowed zero or more than three runner calls")
        correction_updates = correction_updates or []
        evidence_records: list[TestEvidence] = []
        correction_index = 0
        prior_correction: CheckCorrection | None = None
        attempts_before = len(item.attempts)
        bases_before = len(item.bases)

        for automatic_round, status in enumerate(statuses, start=1):
            evidence = self.run_checks(
                item,
                operation,
                status,
                paths,
                automatic_round=automatic_round,
                findings_cycle=findings_cycle,
                prior_correction=prior_correction,
            )
            evidence_records.append(evidence)
            prior_correction = None
            if status in {"TESTS_PASS", "TESTS_NOT_APPLICABLE", "BLOCKED"}:
                expect(automatic_round == len(statuses), "runner was invoked after a terminal auxiliary status")
                break
            expect(status == "TESTS_FAIL", "unknown auxiliary status bypassed cycle handling")
            if automatic_round == 3:
                expect(automatic_round == len(statuses), "fourth runner invocation followed the third failure")
                break
            expect(automatic_round < len(statuses), "early TESTS_FAIL stopped without an in-operation correction and recheck")
            expect(correction_index < len(correction_updates), "automatic correction evidence is missing")
            update = correction_updates[correction_index]
            correction_index += 1
            changed_files = set(update)
            for path, content in update.items():
                if content is None:
                    self.files.pop(path, None)
                else:
                    self.files[path] = content
            paths |= changed_files
            if operation == "EXECUTE_SLICE":
                item.changed_paths |= changed_files
            else:
                item.corrections |= changed_files
            prior_correction = CheckCorrection(
                operation=operation,
                failed_check=evidence.identifier,
                failure=evidence.failures[0],
                evidence=evidence.summary,
                change=f"objective correction after {evidence.identifier}",
                files=changed_files,
                updated_scope=set(paths),
                in_scope_rationale="failure evidence identifies a necessary change inside the approved slice",
            )
            item.check_corrections.append(prior_correction)

        expect(correction_index == len(correction_updates), "unused automatic correction was supplied")
        expect(len(item.attempts) == attempts_before, "automatic checks created a Validation Attempt")
        expect(len(item.bases) == bases_before and not item.done and item.final_result == "pending", "automatic checks promoted formal authority")
        return evidence_records

    def run_manual_operation(
        self,
        item: Slice,
        operation: str,
        statuses: list[str],
        paths: set[str],
        *,
        preconditions_valid: bool,
        work_applied: bool,
        correction_updates: list[dict[str, bytes | None]] | None = None,
        findings_cycle: str | None = None,
    ) -> list[TestEvidence]:
        calls_before = self.runner_calls
        if not preconditions_valid:
            expect(not work_applied, "invalid precondition allowed implementation or correction")
            expect(not statuses, "precondition-blocked operation supplied a runner result")
            expect(self.runner_calls == calls_before, "precondition-blocked operation invoked the runner")
            return []
        expect(work_applied, "valid operation reached runner cycle before implementation or correction")
        records = self.run_check_cycle(
            item,
            operation,
            statuses,
            paths,
            correction_updates=correction_updates,
            findings_cycle=findings_cycle,
        )
        calls = self.runner_calls - calls_before
        expect(1 <= calls <= 3, "valid manual operation did not invoke the runner from one to three times")
        return records

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
        self.runner_calls += 1
        self.discovery_actions += 1
        identifier = f"attempt-{len(item.attempts) + 1:02d}"
        kind = "initial" if not item.attempts else "revalidation"
        prior_evidence = item.findings_evidence[-1] if item.findings_evidence else (item.implementation_evidence[-1] if item.implementation_evidence else None)
        stale_evidence = False
        if prior_evidence:
            for path, expected in prior_evidence.tested_state.items():
                current = REMOVED if path not in self.files else sha(self.files[path])
                stale_evidence = stale_evidence or current != expected
        if prior_evidence and prior_evidence.status == "TESTS_NOT_APPLICABLE":
            commands = [("fixture-independent-non-applicability-review", 0)]
        else:
            commands = [("fixture-retest-stale-evidence", 0)] if stale_evidence else [("fixture-proportional-validation", 0)]
        self.verification_commands += len(commands)
        attempt = Attempt(
            identifier,
            kind,
            status,
            commands=commands,
            historical_hashes=historical_hashes or {},
            reviewed_test_evidence=prior_evidence is not None,
            stale_test_evidence=stale_evidence,
            reviewed_non_applicability=bool(prior_evidence and prior_evidence.status == "TESTS_NOT_APPLICABLE"),
        )
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
        runner_calls_before = self.runner_calls
        discovery_actions_before = self.discovery_actions
        verification_commands_before = self.verification_commands
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
        expect(self.runner_calls == runner_calls_before, "CLOSE invoked the runner")
        expect(self.discovery_actions == discovery_actions_before, "CLOSE performed runner discovery")
        expect(self.verification_commands == verification_commands_before, "CLOSE executed verification commands")
        return not errors, errors


def manifest(workflow: Workflow, *paths: str) -> list[tuple[str, str]]:
    return [(path, REMOVED if path not in workflow.files else sha(workflow.files[path])) for path in sorted(paths)]


def validation_scenarios() -> None:
    execution_pass = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    item = execution_pass.slices[0]
    records = execution_pass.run_manual_operation(
        item,
        "EXECUTE_SLICE",
        ["TESTS_PASS"],
        {"src/a.txt"},
        preconditions_valid=True,
        work_applied=True,
    )
    evidence = records[0]
    expect(evidence.identifier == "implementation-check-01" and evidence.automatic_round == 1 and len(item.implementation_evidence) == 1, "execution initial TESTS_PASS evidence failed")
    expect(execution_pass.runner_calls >= 1 and execution_pass.verification_commands == 1 and evidence.status != "TESTS_NOT_APPLICABLE", "valid execution skipped the runner or mislabeled an executed verification command")
    expect(not item.attempts and not item.bases and not item.done and item.final_result == "pending", "execution TESTS_PASS promoted slice")

    precondition_blocked = Workflow([Slice(1, {"src/a.txt"}, changed_paths=set())], {"src/a.txt": b"a"})
    records = precondition_blocked.run_manual_operation(
        precondition_blocked.slices[0],
        "EXECUTE_SLICE",
        [],
        {"src/a.txt"},
        preconditions_valid=False,
        work_applied=False,
    )
    expect(not records and precondition_blocked.runner_calls == 0, "precondition block before implementation invoked the runner")

    execution_fail_then_pass = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"bad"})
    item = execution_fail_then_pass.slices[0]
    records = execution_fail_then_pass.run_check_cycle(
        item,
        "EXECUTE_SLICE",
        ["TESTS_FAIL", "TESTS_PASS"],
        {"src/a.txt"},
        correction_updates=[{"src/a.txt": b"fixed"}],
    )
    expect([record.status for record in records] == ["TESTS_FAIL", "TESTS_PASS"], "one failure then success did not recheck")
    expect([record.identifier for record in records] == ["implementation-check-01", "implementation-check-02"], "execution evidence was not append-only")
    expect(records[1].correction_applied != "none" and records[1].files_changed_between_rounds == {"src/a.txt"}, "between-round correction evidence missing")
    expect(len(item.check_corrections) == 1 and not item.findings and not item.attempts and not item.done, "execution retry changed formal authority")

    execution_two_fails_then_pass = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"bad-1"})
    item = execution_two_fails_then_pass.slices[0]
    records = execution_two_fails_then_pass.run_check_cycle(
        item,
        "EXECUTE_SLICE",
        ["TESTS_FAIL", "TESTS_FAIL", "TESTS_PASS"],
        {"src/a.txt"},
        correction_updates=[{"src/a.txt": b"bad-2"}, {"src/a.txt": b"fixed"}],
    )
    expect(len(records) == 3 and records[-1].status == "TESTS_PASS", "two failures then success did not use all three rounds")
    expect([record.automatic_round for record in records] == [1, 2, 3] and len(item.check_corrections) == 2, "three-round execution history is incomplete")

    execution_three_fails = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"bad-1"})
    item = execution_three_fails.slices[0]
    records = execution_three_fails.run_check_cycle(
        item,
        "EXECUTE_SLICE",
        ["TESTS_FAIL", "TESTS_FAIL", "TESTS_FAIL"],
        {"src/a.txt"},
        correction_updates=[{"src/a.txt": b"bad-2"}, {"src/a.txt": b"bad-3"}],
    )
    expect(len(records) == 3 and execution_three_fails.runner_calls == 3, "third failure allowed a fourth runner call")
    expect(len(item.check_corrections) == 2 and not item.attempts and not item.done, "third failure applied an extra correction or formalized the slice")

    execution_not_applicable = Workflow([Slice(1, {"docs/a.md"}, changed_paths={"docs/a.md"})], {"docs/a.md": b"docs"})
    item = execution_not_applicable.slices[0]
    records = execution_not_applicable.run_check_cycle(item, "EXECUTE_SLICE", ["TESTS_NOT_APPLICABLE"], {"docs/a.md"})
    evidence = records[0]
    expect(evidence.discovery_sources and evidence.verification_types and evidence.non_applicability_rationale != "not_applicable", "non-applicability lacks objective discovery")
    expect(
        not evidence.commands
        and evidence.no_verification_command_confirmation == "no verification command executed"
        and execution_not_applicable.verification_commands == 0
        and execution_not_applicable.discovery_actions > 0,
        "non-applicability did not distinguish discovery from verification",
    )
    expect(not item.attempts and not item.bases and not item.done, "non-applicability promoted slice authority")

    execution_blocked = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    item = execution_blocked.slices[0]
    evidence = execution_blocked.run_check_cycle(item, "EXECUTE_SLICE", ["BLOCKED"], {"src/a.txt"})[0]
    expect(
        evidence.blockers
        and "tool is unavailable" in evidence.blockers[0]
        and execution_blocked.discovery_actions > 0
        and execution_blocked.verification_commands == 0
        and not evidence.commands
        and not item.check_corrections
        and not item.attempts
        and not item.done,
        "applicable check with missing tool did not remain BLOCKED",
    )

    global_sequence = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    item = global_sequence.slices[0]
    global_sequence.run_check_cycle(item, "EXECUTE_SLICE", ["TESTS_PASS"], {"src/a.txt"})
    global_sequence.run_check_cycle(item, "EXECUTE_SLICE", ["TESTS_PASS"], {"src/a.txt"})
    expect([record.identifier for record in item.implementation_evidence] == ["implementation-check-01", "implementation-check-02"], "later manual execution reset evidence sequence")
    expect([record.automatic_round for record in item.implementation_evidence] == [1, 1], "automatic round did not reset per manual operation")

    findings_pass = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"bad"})
    item = findings_pass.slices[0]
    findings_pass.validate(item, "NEEDS_FIX", finding="finding-01")
    findings_pass.files["src/a.txt"] = b"fixed"
    item.corrections.add("src/a.txt")
    attempt_count = len(item.attempts)
    records = findings_pass.run_manual_operation(
        item,
        "APPLY_FINDINGS",
        ["TESTS_FAIL", "TESTS_PASS"],
        {"src/a.txt"},
        preconditions_valid=True,
        work_applied=True,
        correction_updates=[{"src/a.txt": b"fixed-after-recheck"}],
        findings_cycle="attempt-01",
    )
    expect(findings_pass.runner_calls - attempt_count >= 1, "valid APPLY_FINDINGS skipped the runner")
    expect(records[-1].findings_verified == ["finding-01"] and len(item.attempts) == attempt_count and not item.bases and not item.done, "findings failure then success changed authority")
    expect(item.findings == ["finding-01"] and len(item.check_corrections) == 1, "findings retry did not preserve history")

    findings_three_fails = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"bad"})
    item = findings_three_fails.slices[0]
    findings_three_fails.validate(item, "NEEDS_FIX", finding="finding-01")
    item.corrections.add("src/a.txt")
    attempt_count = len(item.attempts)
    records = findings_three_fails.run_check_cycle(
        item,
        "APPLY_FINDINGS",
        ["TESTS_FAIL", "TESTS_FAIL", "TESTS_FAIL"],
        {"src/a.txt"},
        correction_updates=[{"src/a.txt": b"bad-2"}, {"src/a.txt": b"bad-3"}],
        findings_cycle="attempt-01",
    )
    expect(len(records) == 3 and findings_three_fails.runner_calls == attempt_count + 3, "findings third failure allowed a fourth check")
    expect(records[-1].unsupported_findings == ["finding-01"] and item.findings == ["finding-01"] and len(item.attempts) == attempt_count and not item.done, "findings three-failure history was not preserved")

    findings_not_applicable = Workflow([Slice(1, {"docs/a.md"}, changed_paths={"docs/a.md"})], {"docs/a.md": b"bad docs"})
    item = findings_not_applicable.slices[0]
    findings_not_applicable.validate(item, "NEEDS_FIX", finding="finding-docs")
    item.corrections.add("docs/a.md")
    attempt_count = len(item.attempts)
    evidence = findings_not_applicable.run_check_cycle(
        item,
        "APPLY_FINDINGS",
        ["TESTS_NOT_APPLICABLE"],
        {"docs/a.md"},
        findings_cycle="attempt-01",
    )[0]
    expect(not evidence.commands and item.findings == ["finding-docs"] and len(item.attempts) == attempt_count and not item.done, "findings non-applicability resolved findings or created authority")

    non_applicable_then_validated = Workflow([Slice(1, {"docs/a.md"}, changed_paths={"docs/a.md"})], {"docs/a.md": b"docs"})
    item = non_applicable_then_validated.slices[0]
    non_applicable_then_validated.run_check_cycle(item, "EXECUTE_SLICE", ["TESTS_NOT_APPLICABLE"], {"docs/a.md"})
    non_applicable_then_validated.validate(item, "PASS", manifest(non_applicable_then_validated, "docs/a.md"))
    expect(item.attempts[-1].reviewed_non_applicability and item.attempts[-1].commands == [("fixture-independent-non-applicability-review", 0)], "formal validation did not independently review non-applicability")
    expect(item.attempts[-1].status in {"PASS", "NEEDS_FIX", "BLOCKED"} and item.done, "formal validation accepted an auxiliary verdict")

    checked_then_validated = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    item = checked_then_validated.slices[0]
    checked_then_validated.run_checks(item, "EXECUTE_SLICE", "TESTS_PASS", {"src/a.txt"})
    checked_then_validated.validate(item, "PASS", manifest(checked_then_validated, "src/a.txt"))
    expect(item.attempts[-1].reviewed_test_evidence and item.done and item.bases[0].origin == "attempt-01", "formal PASS after checks failed")

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
    findings.run_checks(item, "APPLY_FINDINGS", "TESTS_PASS", {"src/a.txt", "tests/a.txt"}, findings_cycle="attempt-01")
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

    stale = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"tested"})
    item = stale.slices[0]
    stale.run_checks(item, "EXECUTE_SLICE", "TESTS_PASS", {"src/a.txt"})
    stale.files["src/a.txt"] = b"changed-after-checks"
    stale.validate(item, "PASS", manifest(stale, "src/a.txt"))
    expect(item.attempts[-1].stale_test_evidence and item.attempts[-1].commands == [("fixture-retest-stale-evidence", 0)] and item.done, "stale test evidence was trusted")

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

    close_read_only = Workflow([Slice(1, {"src/a.txt"}, changed_paths={"src/a.txt"})], {"src/a.txt": b"a"})
    item = close_read_only.slices[0]
    close_read_only.run_checks(item, "EXECUTE_SLICE", "TESTS_PASS", {"src/a.txt"})
    close_read_only.validate(item, "PASS", manifest(close_read_only, "src/a.txt"))
    runner_calls = close_read_only.runner_calls
    discovery_actions = close_read_only.discovery_actions
    verification_commands = close_read_only.verification_commands
    expect(
        close_read_only.close()[0]
        and close_read_only.runner_calls == runner_calls
        and close_read_only.discovery_actions == discovery_actions
        and close_read_only.verification_commands == verification_commands,
        "CLOSE ran discovery, verification, or runner",
    )


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
            ("implementation-test-evidence", "## Implementation Test Evidence\n\n- none", "## Implementation Test Evidence\n\n### implementation-check-01\n\n- Status: TESTS_PASS"),
            ("findings-test-evidence", "## Findings Test Evidence\n\n- none", "## Findings Test Evidence\n\n### findings-check-01\n\n- Status: TESTS_FAIL"),
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
        "executor": Path("skills/stnl-slice-executor/SKILL.md"),
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
        "executor": ["configured runner at least once and at most three times", "The first invocation is mandatory", "cannot be skipped because the change appears simple", "Once implementation or correction has occurred, the operation cannot end without invoking", "without running verification commands in the main context", "Implementation Test Evidence", "Findings Test Evidence", "`TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE`, or `BLOCKED`", "Never make a fourth automatic invocation", "use an unbounded loop", "A later manual invocation has its own three-call budget", "no verification command was executed", "read-only actions used only to discover applicable checks are permitted", "create a Validation Attempt or Effective Validation Base"],
        "quality": ["Prior test evidence is auxiliary", "tested file state is still current", "executes or repeats checks proportionally", "independently review a prior `TESTS_NOT_APPLICABLE`", "which read-only discovery actions were performed", "which discovery sources were consulted", "which verification types were considered", "whether any applicable verification command was omitted", "absence of a tool or environment was confused with absence of applicability", "append exactly one deterministic next `attempt-NN`", "Effective Validation Base unchanged or absent", "origin is `NEEDS_FIX` or `BLOCKED`", "A `[x]` slice has exactly one valid Effective Validation Base"],
        "base": ["At most one Effective Validation Base", "Paths are relative, unique", "malformed hashes", "origin attempt that is not the current `PASS`"],
        "closer": ["Earlier hashes remain historical and are never compared", "Do not inspect hashes stored inside Validation Attempts", "Do not run tests", "Do not edit, test, invoke a runner"],
        "template": ["## Implementation Test Evidence", "## Findings Test Evidence", "Automatic check round", "TESTS_NOT_APPLICABLE", "Check discovery sources", "Non-applicability rationale", "No verification-command confirmation", "Discovery-only read operations are allowed", "## Validation Attempts", "## Effective Validation Base", "Result: PASS"],
    }

    def check(texts: dict[str, str]) -> None:
        for name, markers in required.items():
            for marker in markers:
                expect(marker in texts[name], f"missing contract marker {name}: {marker}")
        for marker in ["Automatic check round", "- Check discovery sources:", "Non-applicability rationale", "No verification-command confirmation", "Discovery-only read operations are allowed"]:
            expect(texts["template"].count(marker) == 2, f"template marker must exist in both evidence sections: {marker}")
        for pattern in ["up to three times", "zero to three calls", "may invoke the runner", "runner invocation is optional", "skip the runner when no tests apply", "no runner call is required"]:
            expect(pattern not in texts["executor"].lower(), f"executor permits an optional or zero-call runner cycle: {pattern}")
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
            "Retry checks during CLOSE",
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
        ("executor-one-runner-call", "executor", "configured runner at least once and at most three times", "configured runner exactly once"),
        ("executor-zero-runner-calls", "executor", "configured runner at least once and at most three times", "configured runner zero to three calls"),
        ("executor-up-to-three-only", "executor", "configured runner at least once and at most three times", "configured runner up to three times"),
        ("executor-optional-runner", "executor", "The first invocation is mandatory", "Runner invocation is optional"),
        ("executor-skips-no-tests", "executor", "cannot be skipped because the change appears simple or because no check is expected to apply", "skip the runner when no tests apply"),
        ("executor-unbounded-loop", "executor", "Never make a fourth automatic invocation, use an unbounded loop", "Use an unbounded loop"),
        ("executor-fourth-call", "executor", "Never make a fourth automatic invocation", "Make a fourth automatic invocation"),
        ("executor-missing-not-applicable", "executor", "`TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE`, or `BLOCKED`", "`TESTS_PASS`, `TESTS_FAIL`, or `BLOCKED`"),
        ("executor-resets-check-sequence", "executor", "A later manual invocation has its own three-call budget but continues each section's sequence", "A later manual invocation resets each section's sequence"),
        ("check-creates-formal-authority", "executor", "create a Validation Attempt or Effective Validation Base", "create formal validation authority"),
        ("executor-direct-checks", "executor", "without running verification commands in the main context", "after running verification commands in the main context"),
        ("executor-no-implementation-evidence", "executor", "Implementation Test Evidence", "Execution Notes"),
        ("executor-no-findings-evidence", "executor", "Findings Test Evidence", "Correction Notes"),
        ("quality-trusts-stale-evidence", "quality", "tested file state is still current", "prior evidence exists"),
        ("quality-trusts-not-applicable", "quality", "independently review a prior `TESTS_NOT_APPLICABLE`", "accept a prior `TESTS_NOT_APPLICABLE` without review"),
        ("quality-omits-discovery-sources", "quality", "which discovery sources were consulted", "whether a non-applicability status exists"),
        ("template-missing-automatic-round", "template", "Automatic check round", "Check round"),
        ("template-missing-check-discovery", "template", "- Check discovery sources:", "- Check sources omitted:"),
        ("template-missing-non-applicability-rationale", "template", "Non-applicability rationale", "No rationale"),
        ("template-allows-command-for-non-applicable", "template", "No verification-command confirmation", "Verification commands may execute"),
        ("template-ambiguous-confirmation", "template", "No verification-command confirmation", "No-command confirmation"),
        ("template-omits-discovery-verification-distinction", "template", "Discovery-only read operations are allowed and summarized under `Check discovery sources`; they are not verification commands.", "Discovery details omitted."),
        ("closer-historical-hashes", "closer", "## CLOSE", "Recalculate SHA-256 for every path in each validation base\n\n## CLOSE"),
        ("closer-runs-tests", "closer", "Do not run tests", "Run tests"),
        ("closer-calls-runner", "closer", "Do not edit, test, invoke a runner", "Invoke a runner"),
        ("closer-retries-checks", "closer", "## CLOSE", "Retry checks during CLOSE\n\n## CLOSE"),
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
    print("PASS: valid EXECUTE_SLICE and APPLY_FINDINGS invoke the runner at least once; precondition block may invoke it zero times")
    print("PASS: EXECUTE_SLICE initial success, fail/pass, fail/fail/pass, three failures, TESTS_NOT_APPLICABLE, and BLOCKED")
    print("PASS: APPLY_FINDINGS retry, three failures, and TESTS_NOT_APPLICABLE preserve findings and formal authority")
    print("PASS: discovery_actions and verification_commands are distinct; non-applicability performs discovery with zero verification commands")
    print("PASS: an executed verification command cannot be TESTS_NOT_APPLICABLE; an applicable check with missing tooling is BLOCKED")
    print("PASS: automatic check evidence is append-only, round-limited to 3, and records between-round corrections")
    print("PASS: formal validation independently reviews TESTS_NOT_APPLICABLE and keeps PASS | NEEDS_FIX | BLOCKED")
    print("PASS: direct PASS, NEEDS_FIX, BLOCKED, findings revalidation, and multiple attempts")
    print("PASS: explicit NEEDS_FIX -> APPLY_FINDINGS -> revalidation PASS -> CLOSE PASS")
    print("PASS: stale test evidence triggers proportional retest before formal PASS")
    print("PASS: drift, removals, historical hashes, and serial final validation ownership")
    print("PASS: CLOSE invokes no runner and executes no tests")
    print("PASS: explicit slice-01 shared PASS -> slice-02 shared PASS -> CLOSE PASS")
    print("PASS: PLAN, REVIEW_PLAN, MATERIALIZE_TASKS, and REVIEW_TASKS monotonic state gates")
    print("PASS: blocked operations preserve bytes and leave no partial task set")
    print("PASS: 39 focused negative execution-contract mutations rejected")


if __name__ == "__main__":
    main()
