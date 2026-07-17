#!/usr/bin/env python3
"""Adversarial subprocess tests for lifecycle publisher crash recovery."""

from __future__ import annotations

import json
import os
import runpy
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Callable


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PUBLISHER = SCRIPTS / "publish_spec_lifecycle.py"
sys.path.insert(0, str(SCRIPTS))

import publish_spec_lifecycle as publisher  # noqa: E402
from publish_spec_lifecycle import (  # noqa: E402
    ValidationError,
    recover_incomplete_publication,
    publish_candidate,
)
from build_closed_spec import build_closed_candidate  # noqa: E402
from create_readiness_attestation import (  # noqa: E402
    create_readiness_attestation,
    validate_readiness_attestation,
)
from validate_spec_lifecycle import (  # noqa: E402
    is_os_metadata,
    validate_close_transition,
    validate_workspace,
    workspace_snapshot,
)


FIXTURES = runpy.run_path(str(SCRIPTS / "test-spec-lifecycle.py"), run_name="publisher_fixture_library")
append_requirement: Callable[..., None] = FIXTURES["append_requirement"]
file_snapshot: Callable[..., dict[str, str]] = FIXTURES["file_snapshot"]
requirement_item: Callable[..., str] = FIXTURES["requirement_item"]
write_full_workspace: Callable[..., None] = FIXTURES["write_full_workspace"]
write_resume_manifest: Callable[..., Path] = FIXTURES["write_resume_manifest"]


CRASH_ENV = "STNL_PUBLISHER_TEST_ONLY_CRASH_AT_CHECKPOINT"
FORCE_ROLLBACK_ENV = "STNL_PUBLISHER_TEST_ONLY_FORCE_ROLLBACK"
MUTATE_SOURCE_ENV = "STNL_PUBLISHER_TEST_ONLY_MUTATE_SOURCE_BEFORE_BACKUP_RENAME"
ACK_ENV = "STNL_PUBLISHER_TEST_ONLY_ACKNOWLEDGE_PROCESS_KILL"
ACK = "YES_THIS_IS_AN_ISOLATED_PUBLISHER_CRASH_TEST"
SOURCE_CONFLICT_DIAGNOSTIC = (
    "source changed during publish; publication aborted; concurrent source preserved"
)
RESTORED_SOURCE_INVALID_DIAGNOSTIC = (
    "official target restored but workspace validation failed"
)
OBJECTIVE_LINE = "Provide deterministic invitation expiration behavior."

CHECKPOINTS = (
    "JOURNAL_PREPARED",
    "TARGET_TO_BACKUP_RENAMED",
    "STAGE_TO_TARGET_RENAMED",
    "BEFORE_TARGET_VALIDATION",
    "AFTER_TARGET_VALIDATION",
    "BEFORE_BACKUP_REMOVAL",
    "DURING_ROLLBACK",
)

EXPECTED_LAYOUT = {
    "JOURNAL_PREPARED": ("prepared", True, True, False, "source"),
    "TARGET_TO_BACKUP_RENAMED": ("prepared", False, True, True, "source"),
    "STAGE_TO_TARGET_RENAMED": ("backup_verified", True, False, True, "source"),
    "BEFORE_TARGET_VALIDATION": ("candidate_promoted", True, False, True, "source"),
    "AFTER_TARGET_VALIDATION": ("candidate_validated", True, False, True, "candidate"),
    "BEFORE_BACKUP_REMOVAL": ("committed", True, False, True, "candidate"),
    "DURING_ROLLBACK": ("rollback_required", False, True, True, "source"),
}


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def expect_validation_error(action: Callable[[], object], expected: str) -> None:
    try:
        action()
    except ValidationError as exc:
        expect(expected in str(exc), f"wrong ValidationError; expected {expected!r}, got {exc!r}")
    else:
        raise AssertionError(f"expected ValidationError containing {expected!r}")


def add_valid_objective_trailing_whitespace(workspace: Path, label: str) -> None:
    feature = workspace / "feature_spec.md"
    original = f"{OBJECTIVE_LINE}\n"
    replacement = f"{OBJECTIVE_LINE} \n"
    text = feature.read_text(encoding="utf-8")
    expect(
        text.count(original) == 1,
        f"{label} fixture has an ambiguous Objective line",
    )
    feature.write_text(text.replace(original, replacement, 1), encoding="utf-8")


def journal_path(target: Path) -> Path:
    return target.parent / f".{target.name}.lifecycle-transaction.json"


def lock_path(target: Path) -> Path:
    return target.parent / f".{target.name}.lifecycle.lock"


def transaction_residues(target: Path) -> list[str]:
    prefixes = (
        f".{target.name}.lifecycle-stage-",
        f".{target.name}.lifecycle-backup-",
        f".{target.name}.lifecycle-journal-tmp-",
    )
    names = [child.name for child in target.parent.iterdir() if child.name.startswith(prefixes)]
    if journal_path(target).exists() or journal_path(target).is_symlink():
        names.append(journal_path(target).name)
    return sorted(names)


def read_journal(target: Path) -> dict[str, object]:
    payload = json.loads(journal_path(target).read_text(encoding="utf-8"))
    expect(isinstance(payload, dict), "journal fixture is not an object")
    return payload


def os_metadata_paths(root: Path) -> list[str]:
    return sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if is_os_metadata(path.relative_to(root))
    )


def build_close_fixture(
    base: Path,
    *,
    target_name: str = "workspace",
    attestation_path: Path | None = None,
) -> tuple[Path, Path, Path]:
    target = base / target_name
    candidate = base / "closed-candidate"
    write_full_workspace(target, "ready")
    attestation = create_readiness_attestation(
        target,
        attestation_path or base / "readiness-attestation.json",
        scope="GLOBAL",
        verdict="READY",
    )
    build_closed_candidate(
        target,
        candidate,
        readiness_attestation=attestation,
    )
    validate_workspace(target)
    validate_workspace(candidate)
    return target, candidate, attestation


def assert_journal_excludes_attestation(
    target: Path,
    attestation: Path,
    attestation_payload: dict[str, object],
    label: str,
) -> None:
    expected_journal_fields = {
        "version",
        "mode",
        "target",
        "stage",
        "backup",
        "phase",
        "source_snapshot_sha256",
        "candidate_snapshot_sha256",
        "observed_source_snapshot_sha256",
        "transaction_id",
    }
    journal = read_journal(target)
    raw = journal_path(target).read_text(encoding="utf-8")
    expect(
        set(journal) == expected_journal_fields,
        f"{label}: journal persisted fields outside the transaction schema",
    )
    expect(str(attestation) not in raw, f"{label}: journal persisted the attestation path")
    expect(attestation.name not in raw, f"{label}: journal persisted the attestation filename")
    for field in ("scope", "verdict", "workspace_identity", "workspace_snapshot_sha256"):
        expect(f'"{field}"' not in raw, f"{label}: journal persisted attestation field {field!r}")
    identity = attestation_payload["workspace_identity"]
    expect(isinstance(identity, dict), f"{label}: fixture attestation identity is malformed")
    for digest in (
        attestation_payload["workspace_snapshot_sha256"],
        identity["path_sha256"],
    ):
        expect(isinstance(digest, str), f"{label}: fixture attestation digest is malformed")
        expect(digest not in raw, f"{label}: journal persisted an attestation digest")


def assert_close_attestation_preflight_rejection(
    *,
    label: str,
    target: Path,
    candidate: Path,
    requested_attestation: Path,
    tracked_attestation: Path,
    diagnostic: str,
) -> None:
    parent_snapshot = workspace_snapshot(target.parent)
    target_snapshot = workspace_snapshot(target)
    candidate_snapshot = workspace_snapshot(candidate)
    attestation_bytes = tracked_attestation.read_bytes()
    target_inode = target.stat().st_ino
    candidate_inode = candidate.stat().st_ino
    attestation_inode = tracked_attestation.stat().st_ino
    lock_existed_before = lock_path(target).exists()
    residues_before = transaction_residues(target)
    original_workspace_lock = publisher._workspace_lock
    lock_entered = False

    def reject_lock_entry(_: Path) -> object:
        nonlocal lock_entered
        lock_entered = True
        raise AssertionError(f"{label}: publisher entered the workspace lock")

    publisher._workspace_lock = reject_lock_entry
    try:
        expect_validation_error(
            lambda: publish_candidate(
                "CLOSE",
                target,
                candidate,
                readiness_attestation=requested_attestation,
            ),
            diagnostic,
        )
    finally:
        publisher._workspace_lock = original_workspace_lock

    expect(not lock_entered, f"{label}: rejection was not pre-lock")
    expect(workspace_snapshot(target.parent) == parent_snapshot, f"{label}: parent inputs changed")
    expect(workspace_snapshot(target) == target_snapshot, f"{label}: source changed")
    expect(workspace_snapshot(candidate) == candidate_snapshot, f"{label}: candidate changed")
    expect(tracked_attestation.read_bytes() == attestation_bytes, f"{label}: attestation bytes changed")
    expect(target.stat().st_ino == target_inode, f"{label}: source inode changed")
    expect(candidate.stat().st_ino == candidate_inode, f"{label}: candidate inode changed")
    expect(tracked_attestation.stat().st_ino == attestation_inode, f"{label}: attestation inode changed")
    expect(lock_path(target).exists() == lock_existed_before, f"{label}: lock state changed")
    expect(transaction_residues(target) == residues_before, f"{label}: transaction residues changed")
    active = validate_workspace(target)
    expect(
        not active.closed and active.status == "ready",
        f"{label}: candidate was promoted or source invalidated",
    )
    expect(validate_workspace(candidate).closed, f"{label}: closed candidate was corrupted")
    expect(
        publisher._workspace_lock is original_workspace_lock,
        f"{label}: workspace-lock sentinel was not restored",
    )


def build_resume_fixture(
    base: Path,
    *,
    target_name: str = "workspace",
) -> tuple[Path, Path, Path, dict[str, str], dict[str, str]]:
    target = base / target_name
    candidate = base / "candidate"
    manifest = base / "resume-manifest.json"
    write_full_workspace(target, "ready")
    shutil.copytree(target, candidate)
    append_requirement(candidate, requirement_item(identifier="R-002", status="out_of_scope"))
    write_resume_manifest(
        manifest,
        target,
        feature_sections=("Requirements",),
        new_ids=("R-002",),
    )
    validate_workspace(target)
    validate_workspace(candidate)
    return target, candidate, manifest, file_snapshot(target), file_snapshot(candidate)


def apply_source_mutation_fixture(root: Path, action: str) -> None:
    fixture = root / "execution/publisher-race"
    if action == "ADD":
        (fixture / "added.txt").write_text("concurrent add\n", encoding="utf-8")
    elif action == "MODIFY":
        (fixture / "modified.txt").write_text("concurrent modification\n", encoding="utf-8")
    elif action == "REMOVE":
        (fixture / "removed.txt").unlink()
    elif action == "SYMLINK":
        link_slot = fixture / "link-slot.txt"
        link_slot.unlink()
        link_slot.symlink_to("modified.txt")
    elif action == "INVALID_SCHEMA":
        (root / "feature_spec.md").write_text(
            "temporarily invalid concurrent source bytes\n",
            encoding="utf-8",
        )
    else:  # pragma: no cover - fixture contract
        raise AssertionError(f"unsupported source mutation fixture action {action!r}")


def build_source_mutation_fixture(
    base: Path,
) -> tuple[Path, Path, Path, dict[str, str], dict[str, str]]:
    target, candidate, manifest, _, _ = build_resume_fixture(base)
    for workspace in (target, candidate):
        fixture = workspace / "execution/publisher-race"
        fixture.mkdir(parents=True)
        (fixture / "modified.txt").write_text("original modification slot\n", encoding="utf-8")
        (fixture / "removed.txt").write_text("original removal slot\n", encoding="utf-8")
        (fixture / "link-slot.txt").write_text("original symlink slot\n", encoding="utf-8")
    write_resume_manifest(
        manifest,
        target,
        feature_sections=("Requirements",),
        new_ids=("R-002",),
    )
    validate_workspace(target)
    validate_workspace(candidate)
    return target, candidate, manifest, file_snapshot(target), file_snapshot(candidate)


def run_publisher(
    mode: str,
    target: Path,
    candidate: Path,
    manifest: Path | None = None,
    *,
    readiness_attestation: Path | None = None,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(PUBLISHER), mode, str(target), str(candidate)]
    if manifest is not None:
        command.extend(("--manifest", str(manifest)))
    if readiness_attestation is not None:
        command.extend(("--readiness-attestation", str(readiness_attestation)))
    child_environment = os.environ.copy()
    child_environment["PYTHONDONTWRITEBYTECODE"] = "1"
    if environment:
        child_environment.update(environment)
    return subprocess.run(
        command,
        cwd=ROOT,
        env=child_environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def crash_environment(checkpoint: str) -> dict[str, str]:
    environment = {CRASH_ENV: checkpoint, ACK_ENV: ACK}
    if checkpoint == "DURING_ROLLBACK":
        environment[FORCE_ROLLBACK_ENV] = "1"
    return environment


def assert_killed(result: subprocess.CompletedProcess[str], checkpoint: str) -> None:
    expect(
        result.returncode in {-signal.SIGKILL, 128 + signal.SIGKILL, 137},
        f"{checkpoint}: publisher was not killed abruptly; rc={result.returncode}, "
        f"stdout={result.stdout!r}, stderr={result.stderr!r}",
    )


def run_crash_checkpoint_matrix() -> int:
    count = 0
    for checkpoint in CHECKPOINTS:
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-crash-{checkpoint.lower()}-") as tmp:
            target, candidate, manifest, source_snapshot, candidate_snapshot = build_resume_fixture(Path(tmp))
            result = run_publisher(
                "RESUME",
                target,
                candidate,
                manifest,
                environment=crash_environment(checkpoint),
            )
            assert_killed(result, checkpoint)
            expect(journal_path(target).is_file(), f"{checkpoint}: durable journal is missing")

            journal = read_journal(target)
            phase, target_exists, stage_exists, backup_exists, expected_final = EXPECTED_LAYOUT[checkpoint]
            stage = target.parent / str(journal["stage"])
            backup = target.parent / str(journal["backup"])
            expect(journal["phase"] == phase, f"{checkpoint}: wrong durable phase {journal['phase']!r}")
            expect(target.exists() == target_exists, f"{checkpoint}: unexpected target layout")
            expect(stage.exists() == stage_exists, f"{checkpoint}: unexpected stage layout")
            expect(backup.exists() == backup_exists, f"{checkpoint}: unexpected backup layout")
            if checkpoint != "JOURNAL_PREPARED":
                expect(backup.exists(), f"{checkpoint}: rollback backup was removed prematurely")

            recovered = recover_incomplete_publication(target)
            expect(recovered, f"{checkpoint}: recovery did not observe the journal")
            expect(target.is_dir(), f"{checkpoint}: official workspace is absent after recovery")
            validate_workspace(target)
            expected_snapshot = source_snapshot if expected_final == "source" else candidate_snapshot
            expect(file_snapshot(target) == expected_snapshot, f"{checkpoint}: recovery produced a mixed state")
            expect(not (target / "resume-manifest.json").exists(), f"{checkpoint}: manifest persisted in target")
            expect(not transaction_residues(target), f"{checkpoint}: transaction residues remain")

            stable_snapshot = file_snapshot(target)
            expect(not recover_incomplete_publication(target), f"{checkpoint}: second recovery was not a no-op")
            expect(file_snapshot(target) == stable_snapshot, f"{checkpoint}: second recovery changed target")
        count += 1
    return count


def run_init_recovery_cases() -> int:
    count = 0
    for checkpoint in ("JOURNAL_PREPARED", "STAGE_TO_TARGET_RENAMED"):
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-init-{checkpoint.lower()}-") as tmp:
            base = Path(tmp)
            target = base / "workspace"
            candidate = base / "candidate"
            write_full_workspace(candidate, "ready")
            candidate_snapshot = file_snapshot(candidate)
            result = run_publisher(
                "INIT",
                target,
                candidate,
                environment=crash_environment(checkpoint),
            )
            assert_killed(result, checkpoint)
            expect(recover_incomplete_publication(target), f"INIT {checkpoint}: transaction not recovered")
            expect(target.is_dir(), f"INIT {checkpoint}: recovered target is absent")
            expect(file_snapshot(target) == candidate_snapshot, f"INIT {checkpoint}: wrong recovered bytes")
            validate_workspace(target)
            expect(not transaction_residues(target), f"INIT {checkpoint}: residues remain")
            stable = file_snapshot(target)
            expect(not recover_incomplete_publication(target), f"INIT {checkpoint}: second recovery not a no-op")
            expect(file_snapshot(target) == stable, f"INIT {checkpoint}: second recovery mutated target")
        count += 1
    return count


def run_resume_retry_integration() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-resume-retry-") as tmp:
        target, candidate, manifest, _, candidate_snapshot = build_resume_fixture(Path(tmp))
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment=crash_environment("TARGET_TO_BACKUP_RENAMED"),
        )
        assert_killed(result, "TARGET_TO_BACKUP_RENAMED")
        expect(not target.exists(), "RESUME retry fixture did not interrupt after backup rename")

        # A normal fresh publication must recover the old journal under the
        # same lock before it validates and starts its own transaction.
        published = publish_candidate("RESUME", target, candidate, manifest_path=manifest)
        expect(published == target.resolve(), "RESUME retry returned the wrong target")
        expect(target.is_dir(), "RESUME retry left the official workspace absent")
        validate_workspace(target)
        expect(file_snapshot(target) == candidate_snapshot, "RESUME retry produced mixed bytes")
        expect(not (target / manifest.name).exists(), "RESUME retry persisted the manifest")
        expect(not transaction_residues(target), "RESUME retry left transaction residues")
        stable = file_snapshot(target)
        expect(not recover_incomplete_publication(target), "RESUME retry left a recoverable journal")
        expect(file_snapshot(target) == stable, "post-retry recovery changed the workspace")
    return 1


def run_close_renderer_recovery_integration() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-close-renderer-retry-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        candidate = base / "closed-candidate"
        write_full_workspace(target, "ready")
        external = target / "execution/retained.txt"
        external.parent.mkdir(parents=True)
        external.write_text("external state must survive CLOSE\n", encoding="utf-8")
        hardlink_a = target / "execution/hardlink-a.bin"
        hardlink_b = target / "evidence/hardlink-b.bin"
        hardlink_b.parent.mkdir()
        hardlink_a.write_bytes(b"external hardlink topology must survive CLOSE\x00")
        os.link(hardlink_a, hardlink_b)
        symlink_a = target / "execution/symlink-a"
        symlink_b = target / "evidence/symlink-b"
        os.symlink("retained.txt", symlink_a)
        os.link(symlink_a, symlink_b, follow_symlinks=False)
        source_snapshot = file_snapshot(target)
        source_workspace_snapshot = workspace_snapshot(target)
        attestation = create_readiness_attestation(
            target,
            base / "readiness-attestation.json",
            scope="GLOBAL",
            verdict="READY",
        )
        build_closed_candidate(target, candidate, readiness_attestation=attestation)
        candidate_snapshot = file_snapshot(candidate)
        candidate_workspace_snapshot = workspace_snapshot(candidate)
        expect(
            (candidate / "execution/hardlink-a.bin").stat().st_ino
            == (candidate / "evidence/hardlink-b.bin").stat().st_ino,
            "CLOSE renderer did not preserve the external hardlink fixture",
        )
        expect(
            os.lstat(candidate / "execution/symlink-a").st_ino
            == os.lstat(candidate / "evidence/symlink-b").st_ino,
            "CLOSE renderer did not preserve the external symlink-hardlink fixture",
        )

        result = run_publisher(
            "CLOSE",
            target,
            candidate,
            readiness_attestation=attestation,
            environment=crash_environment("TARGET_TO_BACKUP_RENAMED"),
        )
        assert_killed(result, "TARGET_TO_BACKUP_RENAMED")
        expect(not target.exists(), "CLOSE fixture did not interrupt after backup rename")
        expect(recover_incomplete_publication(target), "CLOSE backup transaction was not recovered")
        expect(target.is_dir(), "CLOSE recovery left the official workspace absent")
        recovered = validate_workspace(target)
        expect(not recovered.closed and recovered.status == "ready", "CLOSE recovery did not restore active ready state")
        expect(file_snapshot(target) == source_snapshot, "CLOSE recovery changed source/external bytes")
        expect(
            workspace_snapshot(target) == source_workspace_snapshot,
            "CLOSE recovery changed source/external hardlink topology",
        )
        expect(external.read_text(encoding="utf-8") == "external state must survive CLOSE\n", "CLOSE recovery lost external data")

        publish_candidate(
            "CLOSE",
            target,
            candidate,
            readiness_attestation=attestation,
        )
        closed = validate_workspace(target)
        expect(closed.closed and closed.status == "closed", "CLOSE retry did not publish a valid closed workspace")
        expect(file_snapshot(target) == candidate_snapshot, "CLOSE retry differs from deterministic renderer candidate")
        expect(
            workspace_snapshot(target) == candidate_workspace_snapshot,
            "CLOSE retry differs from deterministic renderer hardlink topology",
        )
        expect(
            (target / "execution/retained.txt").read_text(encoding="utf-8")
            == "external state must survive CLOSE\n",
            "CLOSE retry mutated external data",
        )
        expect(not transaction_residues(target), "CLOSE retry left transaction residues")
        final_snapshot = file_snapshot(target)
        expect_validation_error(
            lambda: publish_candidate(
                "CLOSE",
                target,
                candidate,
                readiness_attestation=attestation,
            ),
            "readiness attestation requires an active ready workspace",
        )
        expect(file_snapshot(target) == final_snapshot, "repeated CLOSE attempt corrupted closed state")
        expect(validate_workspace(target).closed, "repeated CLOSE attempt reopened/invalidated the workspace")
        expect(not transaction_residues(target), "repeated CLOSE attempt left transaction residues")
        attestation.unlink()
        expect(not attestation.exists(), "terminal CLOSE retained its ephemeral attestation")
    return 1


def run_close_recovery_without_ephemeral_attestation_cases() -> int:
    count = 0
    cases = (
        ("TARGET_TO_BACKUP_RENAMED", "remove", "rollback"),
        ("AFTER_TARGET_VALIDATION", "corrupt", "commit"),
    )
    for checkpoint, attestation_action, recovery_outcome in cases:
        with tempfile.TemporaryDirectory(
            prefix=f"stnl-publisher-close-receiptless-{recovery_outcome}-"
        ) as tmp:
            base = Path(tmp)
            target, candidate, attestation = build_close_fixture(base)
            source_snapshot = workspace_snapshot(target)
            candidate_snapshot = workspace_snapshot(candidate)
            attestation_payload = json.loads(attestation.read_text(encoding="utf-8"))
            expect(isinstance(attestation_payload, dict), "fixture attestation is not an object")

            result = run_publisher(
                "CLOSE",
                target,
                candidate,
                readiness_attestation=attestation,
                environment=crash_environment(checkpoint),
            )
            assert_killed(result, checkpoint)
            transaction = read_journal(target)
            expected_phase = "prepared" if recovery_outcome == "rollback" else "candidate_validated"
            expect(
                transaction["phase"] == expected_phase,
                f"{checkpoint}: journal phase does not exercise {recovery_outcome}",
            )
            assert_journal_excludes_attestation(
                target,
                attestation,
                attestation_payload,
                checkpoint,
            )

            if attestation_action == "remove":
                expect(not target.exists(), "receiptless rollback fixture retained the official target")
                attestation.unlink()
                expect(not attestation.exists(), "receiptless rollback fixture retained the receipt")
                expect(
                    recover_incomplete_publication(target),
                    "CLOSE rollback recovery depended on the removed receipt",
                )
                active = validate_workspace(target)
                expect(
                    not active.closed and active.status == "ready",
                    "receiptless CLOSE rollback did not restore active ready source",
                )
                expect(
                    workspace_snapshot(target) == source_snapshot,
                    "receiptless CLOSE rollback changed the source",
                )
                expect(not attestation.exists(), "recovery recreated the ephemeral receipt")
                expect(not transaction_residues(target), "receiptless CLOSE rollback left residues")

                recreated = create_readiness_attestation(
                    target,
                    attestation,
                    scope="GLOBAL",
                    verdict="READY",
                )
                expect(recreated == attestation, "retry recreated the receipt at the wrong path")
                publish_candidate(
                    "CLOSE",
                    target,
                    candidate,
                    readiness_attestation=recreated,
                )
                expect(validate_workspace(target).closed, "receiptless rollback retry did not close")
                expect(
                    workspace_snapshot(target) == candidate_snapshot,
                    "receiptless rollback retry did not publish the exact candidate",
                )
                expect(not transaction_residues(target), "receiptless rollback retry left residues")
                recreated.unlink()
            else:
                expect(validate_workspace(target).closed, "receiptless commit fixture lacks closed target")
                attestation.write_bytes(b"corrupted ephemeral receipt\n")
                corrupt_bytes = attestation.read_bytes()
                corrupt_inode = attestation.stat().st_ino
                expect(
                    recover_incomplete_publication(target),
                    "CLOSE commit recovery depended on the corrupted receipt",
                )
                expect(validate_workspace(target).closed, "receiptless CLOSE recovery did not commit")
                expect(
                    workspace_snapshot(target) == candidate_snapshot,
                    "receiptless CLOSE commit changed the validated candidate",
                )
                expect(attestation.read_bytes() == corrupt_bytes, "recovery changed corrupted receipt bytes")
                expect(attestation.stat().st_ino == corrupt_inode, "recovery replaced corrupted receipt")
                expect(not transaction_residues(target), "receiptless CLOSE commit left residues")

            expect(
                workspace_snapshot(candidate) == candidate_snapshot,
                f"{checkpoint}: recovery changed the candidate input",
            )
        count += 1
    return count


def run_close_stale_attestation_whitespace_case() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-close-stale-whitespace-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        candidate = base / "closed-candidate"
        attestation = base / "readiness-attestation.json"
        write_full_workspace(target, "ready")
        create_readiness_attestation(
            target,
            attestation,
            scope="GLOBAL",
            verdict="READY",
        )
        build_closed_candidate(
            target,
            candidate,
            readiness_attestation=attestation,
        )

        add_valid_objective_trailing_whitespace(
            target,
            "CLOSE stale-attestation",
        )

        active = validate_workspace(target)
        expect(
            not active.closed and active.status == "ready",
            "valid Objective trailing whitespace changed lifecycle state",
        )
        expect_validation_error(
            lambda: validate_readiness_attestation(
                target,
                attestation,
                candidate=candidate,
            ),
            "readiness attestation is stale; rerun READINESS GLOBAL",
        )

        target_snapshot = workspace_snapshot(target)
        candidate_snapshot = workspace_snapshot(candidate)
        attestation_bytes = attestation.read_bytes()
        target_inode = target.stat().st_ino
        candidate_inode = candidate.stat().st_ino
        attestation_inode = attestation.stat().st_ino
        lock_existed_before = lock_path(target).exists()
        residues_before = transaction_residues(target)
        expect(not lock_existed_before, "stale-attestation fixture unexpectedly started with a lock")
        expect(not residues_before, "stale-attestation fixture unexpectedly started with residues")

        expect_validation_error(
            lambda: publish_candidate(
                "CLOSE",
                target,
                candidate,
                readiness_attestation=attestation,
            ),
            "readiness attestation is stale; rerun READINESS GLOBAL",
        )

        expect(workspace_snapshot(target) == target_snapshot, "stale CLOSE changed source bytes/types")
        expect(
            workspace_snapshot(candidate) == candidate_snapshot,
            "stale CLOSE changed candidate bytes/types",
        )
        expect(attestation.read_bytes() == attestation_bytes, "stale CLOSE changed attestation bytes")
        expect(target.stat().st_ino == target_inode, "stale CLOSE replaced the source directory")
        expect(candidate.stat().st_ino == candidate_inode, "stale CLOSE replaced the candidate directory")
        expect(attestation.stat().st_ino == attestation_inode, "stale CLOSE replaced the attestation")
        expect(
            not lock_path(target).exists(),
            "stale CLOSE created a workspace publication lock",
        )
        expect(not transaction_residues(target), "stale CLOSE created transaction residues")
        active = validate_workspace(target)
        expect(
            not active.closed and active.status == "ready",
            "stale CLOSE published or corrupted the official workspace",
        )
        expect(validate_workspace(candidate).closed, "stale CLOSE corrupted the closed candidate")
    return 1


def run_close_noncanonical_candidate_whitespace_case() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-close-noncanonical-whitespace-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        candidate = base / "closed-candidate"
        attestation = base / "readiness-attestation.json"
        write_full_workspace(target, "ready")
        create_readiness_attestation(
            target,
            attestation,
            scope="GLOBAL",
            verdict="READY",
        )
        build_closed_candidate(
            target,
            candidate,
            readiness_attestation=attestation,
        )
        add_valid_objective_trailing_whitespace(
            candidate,
            "CLOSE noncanonical candidate",
        )

        source = validate_workspace(target)
        closed_candidate = validate_workspace(candidate)
        expect(
            not source.closed and source.status == "ready",
            "noncanonical-candidate fixture source is not active ready",
        )
        expect(closed_candidate.closed, "valid candidate whitespace broke the closed schema")
        validate_readiness_attestation(
            target,
            attestation,
            candidate=candidate,
        )
        validate_close_transition(target, candidate)

        target_snapshot = workspace_snapshot(target)
        candidate_snapshot = workspace_snapshot(candidate)
        attestation_bytes = attestation.read_bytes()
        target_inode = target.stat().st_ino
        candidate_inode = candidate.stat().st_ino
        attestation_inode = attestation.stat().st_ino

        expect_validation_error(
            lambda: publish_candidate(
                "CLOSE",
                target,
                candidate,
                readiness_attestation=attestation,
            ),
            "CLOSE candidate is not the exact deterministic rendering of the attested source",
        )

        expect(
            workspace_snapshot(target) == target_snapshot,
            "noncanonical CLOSE candidate was promoted or source changed",
        )
        expect(
            workspace_snapshot(candidate) == candidate_snapshot,
            "noncanonical CLOSE rejection changed candidate",
        )
        expect(
            attestation.read_bytes() == attestation_bytes,
            "noncanonical CLOSE rejection changed attestation bytes",
        )
        expect(target.stat().st_ino == target_inode, "noncanonical CLOSE replaced source")
        expect(candidate.stat().st_ino == candidate_inode, "noncanonical CLOSE replaced candidate")
        expect(
            attestation.stat().st_ino == attestation_inode,
            "noncanonical CLOSE replaced attestation",
        )
        expect(not transaction_residues(target), "noncanonical CLOSE left transaction residues")
        source = validate_workspace(target)
        expect(
            not source.closed and source.status == "ready",
            "noncanonical CLOSE published or corrupted the official workspace",
        )
        expect(validate_workspace(candidate).closed, "noncanonical CLOSE corrupted candidate")
        validate_readiness_attestation(
            target,
            attestation,
            candidate=candidate,
        )
    return 1


def run_close_candidate_os_metadata_cases() -> int:
    count = 0
    for relative in (
        Path(".DS_Store"),
        Path("._feature_spec.md"),
        Path("__MACOSX/._feature_spec.md"),
    ):
        slug = relative.as_posix().replace("/", "-").replace(".", "dot")
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-close-metadata-{slug}-") as tmp:
            base = Path(tmp)
            target, candidate, attestation = build_close_fixture(base)
            metadata = candidate / relative
            metadata.parent.mkdir(parents=True, exist_ok=True)
            metadata.write_bytes(b"untrusted Finder metadata\n")
            expect(
                relative.as_posix() in os_metadata_paths(candidate),
                f"{relative}: fixture metadata was not classified as OS metadata",
            )
            validate_workspace(candidate)
            validate_close_transition(target, candidate)
            validate_readiness_attestation(target, attestation, candidate=candidate)

            target_snapshot = workspace_snapshot(target)
            candidate_snapshot = workspace_snapshot(candidate)
            attestation_bytes = attestation.read_bytes()
            metadata_bytes = metadata.read_bytes()
            target_inode = target.stat().st_ino
            candidate_inode = candidate.stat().st_ino
            attestation_inode = attestation.stat().st_ino
            metadata_inode = metadata.stat().st_ino

            expect_validation_error(
                lambda: publish_candidate(
                    "CLOSE",
                    target,
                    candidate,
                    readiness_attestation=attestation,
                ),
                "CLOSE candidate contains OS metadata absent from deterministic rendering",
            )

            expect(workspace_snapshot(target) == target_snapshot, f"{relative}: source changed")
            expect(workspace_snapshot(candidate) == candidate_snapshot, f"{relative}: candidate changed")
            expect(attestation.read_bytes() == attestation_bytes, f"{relative}: attestation changed")
            expect(metadata.read_bytes() == metadata_bytes, f"{relative}: candidate metadata changed")
            expect(target.stat().st_ino == target_inode, f"{relative}: source inode changed")
            expect(candidate.stat().st_ino == candidate_inode, f"{relative}: candidate inode changed")
            expect(attestation.stat().st_ino == attestation_inode, f"{relative}: attestation inode changed")
            expect(metadata.stat().st_ino == metadata_inode, f"{relative}: metadata inode changed")
            expect(not os_metadata_paths(target), f"{relative}: metadata reached the official target")
            active = validate_workspace(target)
            expect(
                not active.closed and active.status == "ready",
                f"{relative}: poisoned candidate was promoted",
            )
            expect(not transaction_residues(target), f"{relative}: rejection left transaction residues")
        count += 1
    return count


def run_close_journaled_os_metadata_recovery_cases() -> int:
    count = 0
    cases = (
        ("JOURNAL_PREPARED", "stage", "rollback"),
        ("AFTER_TARGET_VALIDATION", "target", "commit"),
    )
    for checkpoint, injection_location, recovery_outcome in cases:
        with tempfile.TemporaryDirectory(
            prefix=f"stnl-publisher-close-journaled-metadata-{injection_location}-"
        ) as tmp:
            base = Path(tmp)
            target, candidate, attestation = build_close_fixture(base)
            source_snapshot = workspace_snapshot(target)
            candidate_snapshot = workspace_snapshot(candidate)
            attestation_bytes = attestation.read_bytes()

            result = run_publisher(
                "CLOSE",
                target,
                candidate,
                readiness_attestation=attestation,
                environment=crash_environment(checkpoint),
            )
            assert_killed(result, checkpoint)
            transaction = read_journal(target)
            if injection_location == "stage":
                injection_root = target.parent / str(transaction["stage"])
                expect(injection_root.is_dir(), "journaled metadata stage fixture is absent")
            else:
                injection_root = target
                expect(validate_workspace(target).closed, "journaled metadata target fixture is not closed")

            metadata = injection_root / ".DS_Store"
            metadata.write_bytes(b"metadata injected after SIGKILL\n")
            metadata_bytes = metadata.read_bytes()
            metadata_inode = metadata.stat().st_ino
            expect(
                os_metadata_paths(injection_root) == [".DS_Store"],
                f"{checkpoint}: injected metadata was not classified",
            )

            expect_validation_error(
                lambda: recover_incomplete_publication(target),
                "CLOSE candidate contains OS metadata absent from deterministic rendering",
            )
            expect(journal_path(target).is_file(), f"{checkpoint}: failed recovery removed journal evidence")
            expect(metadata.read_bytes() == metadata_bytes, f"{checkpoint}: failed recovery changed metadata")
            expect(metadata.stat().st_ino == metadata_inode, f"{checkpoint}: failed recovery replaced metadata")
            expect(
                workspace_snapshot(candidate) == candidate_snapshot,
                f"{checkpoint}: recovery changed candidate input",
            )
            expect(attestation.read_bytes() == attestation_bytes, f"{checkpoint}: recovery changed attestation")
            expect(transaction_residues(target), f"{checkpoint}: failed recovery discarded all evidence")
            if injection_location == "stage":
                expect(
                    workspace_snapshot(target) == source_snapshot,
                    "stage metadata recovery changed the official source",
                )
                expect(not os_metadata_paths(target), "stage metadata reached the official target")

            metadata.unlink()
            expect(
                recover_incomplete_publication(target),
                f"{checkpoint}: recovery did not resume after metadata removal",
            )
            expect(not os_metadata_paths(target), f"{checkpoint}: recovered target retained OS metadata")
            expect(not transaction_residues(target), f"{checkpoint}: successful recovery left residues")
            if recovery_outcome == "rollback":
                active = validate_workspace(target)
                expect(
                    not active.closed and active.status == "ready",
                    "journaled stage metadata did not recover by rollback",
                )
                expect(workspace_snapshot(target) == source_snapshot, "metadata rollback changed source")
            else:
                expect(validate_workspace(target).closed, "journaled target metadata did not commit")
                expect(
                    workspace_snapshot(target) == candidate_snapshot,
                    "metadata commit changed the validated candidate",
                )
        count += 1
    return count


def run_readiness_attestation_publisher_contract_cases() -> int:
    count = 0

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-close-missing-attestation-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        candidate = base / "closed-candidate"
        attestation = base / "readiness-attestation.json"
        write_full_workspace(target, "ready")
        create_readiness_attestation(
            target,
            attestation,
            scope="GLOBAL",
            verdict="READY",
        )
        build_closed_candidate(
            target,
            candidate,
            readiness_attestation=attestation,
        )
        target_snapshot = workspace_snapshot(target)
        candidate_snapshot = workspace_snapshot(candidate)
        attestation_bytes = attestation.read_bytes()
        attestation_inode = attestation.stat().st_ino

        expect_validation_error(
            lambda: publish_candidate("CLOSE", target, candidate),
            "CLOSE publication requires --readiness-attestation PATH",
        )
        expect(workspace_snapshot(target) == target_snapshot, "missing CLOSE attestation changed source")
        expect(
            workspace_snapshot(candidate) == candidate_snapshot,
            "missing CLOSE attestation changed candidate",
        )
        expect(attestation.read_bytes() == attestation_bytes, "missing CLOSE attestation changed its file")
        expect(attestation.stat().st_ino == attestation_inode, "missing CLOSE attestation replaced its file")
        expect(not lock_path(target).exists(), "missing CLOSE attestation created a lock")
        expect(not transaction_residues(target), "missing CLOSE attestation created residues")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-init-readiness-attestation-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        candidate = base / "candidate"
        attestation = base / "readiness-attestation.json"
        write_full_workspace(candidate, "ready")
        create_readiness_attestation(
            candidate,
            attestation,
            scope="GLOBAL",
            verdict="READY",
        )
        candidate_snapshot = workspace_snapshot(candidate)
        attestation_bytes = attestation.read_bytes()
        attestation_inode = attestation.stat().st_ino

        expect_validation_error(
            lambda: publish_candidate(
                "INIT",
                target,
                candidate,
                readiness_attestation=attestation,
            ),
            "--readiness-attestation is valid only for CLOSE, not INIT",
        )
        expect(not target.exists(), "INIT accepted an out-of-contract readiness attestation")
        expect(workspace_snapshot(candidate) == candidate_snapshot, "INIT attestation rejection changed candidate")
        expect(attestation.read_bytes() == attestation_bytes, "INIT attestation rejection changed attestation")
        expect(attestation.stat().st_ino == attestation_inode, "INIT attestation rejection replaced attestation")
        expect(not lock_path(target).exists(), "INIT attestation rejection created a lock")
        expect(not transaction_residues(target), "INIT attestation rejection created residues")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-resume-readiness-attestation-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, _, _ = build_resume_fixture(base)
        attestation = base / "readiness-attestation.json"
        create_readiness_attestation(
            target,
            attestation,
            scope="GLOBAL",
            verdict="READY",
        )
        target_snapshot = workspace_snapshot(target)
        candidate_snapshot = workspace_snapshot(candidate)
        manifest_bytes = manifest.read_bytes()
        attestation_bytes = attestation.read_bytes()
        attestation_inode = attestation.stat().st_ino

        expect_validation_error(
            lambda: publish_candidate(
                "RESUME",
                target,
                candidate,
                manifest_path=manifest,
                readiness_attestation=attestation,
            ),
            "--readiness-attestation is valid only for CLOSE, not RESUME",
        )
        expect(workspace_snapshot(target) == target_snapshot, "RESUME attestation rejection changed source")
        expect(
            workspace_snapshot(candidate) == candidate_snapshot,
            "RESUME attestation rejection changed candidate",
        )
        expect(manifest.read_bytes() == manifest_bytes, "RESUME attestation rejection changed manifest")
        expect(attestation.read_bytes() == attestation_bytes, "RESUME attestation rejection changed attestation")
        expect(attestation.stat().st_ino == attestation_inode, "RESUME attestation rejection replaced attestation")
        expect(not lock_path(target).exists(), "RESUME attestation rejection created a lock")
        expect(not transaction_residues(target), "RESUME attestation rejection created residues")
    count += 1
    return count


def run_readiness_attestation_path_preflight_cases() -> int:
    count = 0

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-attestation-traversal-") as tmp:
        base = Path(tmp)
        target, candidate, attestation = build_close_fixture(base)
        detour = base / "detour"
        detour.mkdir()
        assert_close_attestation_preflight_rejection(
            label="attestation traversal",
            target=target,
            candidate=candidate,
            requested_attestation=detour / ".." / attestation.name,
            tracked_attestation=attestation,
            diagnostic="readiness attestation must not contain path traversal",
        )
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-attestation-ancestor-symlink-") as tmp:
        base = Path(tmp)
        receipt_root = base / "receipt-root"
        receipt_root.mkdir()
        target, candidate, attestation = build_close_fixture(
            base,
            attestation_path=receipt_root / "readiness-attestation.json",
        )
        alias = base / "receipt-alias"
        alias.symlink_to(receipt_root, target_is_directory=True)
        assert_close_attestation_preflight_rejection(
            label="attestation ancestor symlink",
            target=target,
            candidate=candidate,
            requested_attestation=alias / attestation.name,
            tracked_attestation=attestation,
            diagnostic="readiness attestation must not contain symlink components",
        )
    count += 1

    for internal_location in ("source", "candidate"):
        with tempfile.TemporaryDirectory(
            prefix=f"stnl-publisher-attestation-inside-{internal_location}-"
        ) as tmp:
            base = Path(tmp)
            target, candidate, attestation = build_close_fixture(base)
            internal_root = target if internal_location == "source" else candidate
            internal_attestation = internal_root / "internal-readiness-attestation.json"
            shutil.copy2(attestation, internal_attestation)
            assert_close_attestation_preflight_rejection(
                label=f"attestation inside {internal_location}",
                target=target,
                candidate=candidate,
                requested_attestation=internal_attestation,
                tracked_attestation=internal_attestation,
                diagnostic="readiness attestation must remain outside source and candidate workspaces",
            )
        count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-attestation-casefold-internal-") as tmp:
        base = Path(tmp)
        fixture_base = base / "ParentCase"
        target, candidate, attestation = build_close_fixture(
            fixture_base,
            target_name="Workspace",
        )
        internal_attestation = target / "internal-readiness-attestation.json"
        shutil.copy2(attestation, internal_attestation)
        requested = base / "parentcase/workspace/INTERNAL-READINESS-ATTESTATION.JSON"
        if requested.exists():
            expect(
                os.path.samefile(internal_attestation, requested),
                "casefold attestation alias does not address the physical internal receipt",
            )
            assert_close_attestation_preflight_rejection(
                label="physical casefold attestation inside source",
                target=target,
                candidate=candidate,
                requested_attestation=requested,
                tracked_attestation=internal_attestation,
                diagnostic="readiness attestation must remain outside source and candidate workspaces",
            )
            count += 1

    return count


def run_readiness_attestation_runtime_metadata_collision_matrix(
    *,
    target_name: str = "workspace",
    namespace_target_name: str | None = None,
) -> int:
    count = 0
    for reserved_kind in ("journal", "lock", "stage", "backup", "journal-temp"):
        with tempfile.TemporaryDirectory(
            prefix=f"stnl-publisher-attestation-{reserved_kind}-collision-"
        ) as tmp:
            base = Path(tmp)
            target = base / target_name
            runtime_target_name = namespace_target_name or target_name
            reserved_paths = {
                "journal": base / f".{runtime_target_name}.lifecycle-transaction.json",
                "lock": base / f".{runtime_target_name}.lifecycle.lock",
                "stage": base / f".{runtime_target_name}.lifecycle-stage-attestation",
                "backup": base / f".{runtime_target_name}.lifecycle-backup-attestation",
                "journal-temp": base / f".{runtime_target_name}.lifecycle-journal-tmp-attestation",
            }
            collision = reserved_paths[reserved_kind]
            target, candidate, attestation = build_close_fixture(
                base,
                target_name=target_name,
                attestation_path=collision,
            )
            expect(attestation.is_file(), f"{reserved_kind}: collision receipt is absent")
            assert_close_attestation_preflight_rejection(
                label=f"attestation/{reserved_kind} runtime collision",
                target=target,
                candidate=candidate,
                requested_attestation=attestation,
                tracked_attestation=attestation,
                diagnostic=(
                    "readiness attestation collides with target-owned publisher "
                    "runtime metadata namespace"
                ),
            )
        count += 1
    return count


def run_unicode_readiness_attestation_runtime_metadata_collision_matrix() -> int:
    return run_readiness_attestation_runtime_metadata_collision_matrix(
        target_name="Cafe\u0301",
        namespace_target_name="Caf\u00e9",
    )


def run_candidate_validation_baseline_cases() -> int:
    count = 0

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-source-validation-baseline-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, _, _ = build_resume_fixture(base)
        expected_source = base / "expected-concurrent-source"
        shutil.copytree(target, expected_source, symlinks=True)
        add_valid_objective_trailing_whitespace(
            expected_source,
            "source-validation baseline",
        )
        expected_source_snapshot = workspace_snapshot(expected_source)
        candidate_snapshot = workspace_snapshot(candidate)
        manifest_bytes = manifest.read_bytes()
        original_validate_candidate = publisher._validate_candidate

        def mutate_source_during_validation(
            mode: str,
            target_path: Path,
            stage: Path,
            manifest_path: Path | None,
            readiness_attestation: Path | None,
        ) -> None:
            original_validate_candidate(
                mode,
                target_path,
                stage,
                manifest_path,
                readiness_attestation,
            )
            add_valid_objective_trailing_whitespace(
                target_path,
                "source-validation baseline",
            )

        publisher._validate_candidate = mutate_source_during_validation
        try:
            expect_validation_error(
                lambda: publish_candidate(
                    "RESUME",
                    target,
                    candidate,
                    manifest_path=manifest,
                ),
                "RESUME source changed during candidate validation",
            )
        finally:
            publisher._validate_candidate = original_validate_candidate

        expect(
            workspace_snapshot(target) == expected_source_snapshot,
            "source-validation baseline did not preserve the concurrent source mutation",
        )
        expect(
            workspace_snapshot(candidate) == candidate_snapshot,
            "source-validation baseline changed the candidate input",
        )
        expect(manifest.read_bytes() == manifest_bytes, "source-validation baseline changed manifest")
        active = validate_workspace(target)
        expect(
            not active.closed and active.status == "ready",
            "source-validation baseline left the official workspace invalid",
        )
        expect(
            "R-002" not in (target / "shared/requirements.md").read_text(encoding="utf-8"),
            "source-validation baseline promoted the candidate",
        )
        expect(not transaction_residues(target), "source-validation baseline left residues")
        expect(
            publisher._validate_candidate is original_validate_candidate,
            "source-validation monkeypatch was not restored",
        )
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-candidate-validation-baseline-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, _, _ = build_resume_fixture(base)
        target_snapshot = workspace_snapshot(target)
        candidate_snapshot = workspace_snapshot(candidate)
        manifest_bytes = manifest.read_bytes()
        original_validate_candidate = publisher._validate_candidate

        def mutate_stage_after_validation(
            mode: str,
            target_path: Path,
            stage: Path,
            manifest_path: Path | None,
            readiness_attestation: Path | None,
        ) -> None:
            original_validate_candidate(
                mode,
                target_path,
                stage,
                manifest_path,
                readiness_attestation,
            )
            add_valid_objective_trailing_whitespace(
                stage,
                "candidate-validation baseline",
            )

        publisher._validate_candidate = mutate_stage_after_validation
        try:
            expect_validation_error(
                lambda: publish_candidate(
                    "RESUME",
                    target,
                    candidate,
                    manifest_path=manifest,
                ),
                "RESUME candidate changed during validation",
            )
        finally:
            publisher._validate_candidate = original_validate_candidate

        expect(
            workspace_snapshot(target) == target_snapshot,
            "candidate-validation baseline changed the source",
        )
        expect(
            workspace_snapshot(candidate) == candidate_snapshot,
            "candidate-validation baseline changed the candidate input",
        )
        expect(manifest.read_bytes() == manifest_bytes, "candidate-validation baseline changed manifest")
        active = validate_workspace(target)
        expect(
            not active.closed and active.status == "ready",
            "candidate-validation baseline invalidated the official workspace",
        )
        expect(
            "R-002" not in (target / "shared/requirements.md").read_text(encoding="utf-8"),
            "candidate-validation baseline promoted the candidate",
        )
        expect(not transaction_residues(target), "candidate-validation baseline left residues")
        expect(
            publisher._validate_candidate is original_validate_candidate,
            "candidate-validation monkeypatch was not restored",
        )
    count += 1
    return count


def run_final_window_source_change_cases() -> int:
    count = 0
    for action in ("ADD", "MODIFY", "REMOVE", "SYMLINK"):
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-source-{action.lower()}-") as tmp:
            base = Path(tmp)
            target, candidate, manifest, _, candidate_snapshot = build_source_mutation_fixture(base)
            expected = base / "expected-concurrent-source"
            shutil.copytree(target, expected, symlinks=True)
            apply_source_mutation_fixture(expected, action)
            expected_snapshot = workspace_snapshot(expected)

            result = run_publisher(
                "RESUME",
                target,
                candidate,
                manifest,
                environment={MUTATE_SOURCE_ENV: action, ACK_ENV: ACK},
            )
            expect(result.returncode == 1, f"{action}: source conflict publish rc={result.returncode}")
            expect(
                SOURCE_CONFLICT_DIAGNOSTIC in result.stderr,
                f"{action}: missing source conflict diagnostic: {result.stderr!r}",
            )
            expect(target.is_dir(), f"{action}: concurrent source was not restored")
            validate_workspace(target)
            expect(
                workspace_snapshot(target) == expected_snapshot,
                f"{action}: restored source does not contain the exact concurrent edit",
            )
            expect(
                file_snapshot(target) != candidate_snapshot,
                f"{action}: stale candidate was promoted over the concurrent source",
            )
            if action == "SYMLINK":
                restored_link = target / "execution/publisher-race/link-slot.txt"
                expect(restored_link.is_symlink(), "SYMLINK: restored entry changed type")
                expect(
                    restored_link.readlink() == Path("modified.txt"),
                    "SYMLINK: restored link target changed",
                )
            expect(not transaction_residues(target), f"{action}: conflict left transaction residues")
            stable = workspace_snapshot(target)
            expect(not recover_incomplete_publication(target), f"{action}: clean conflict remained recoverable")
            expect(workspace_snapshot(target) == stable, f"{action}: idempotent recovery changed source")
        count += 1
    return count


def run_final_window_crash_recovery_case() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-source-crash-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, _, candidate_snapshot = build_source_mutation_fixture(base)
        expected = base / "expected-concurrent-source"
        shutil.copytree(target, expected, symlinks=True)
        apply_source_mutation_fixture(expected, "MODIFY")
        expected_snapshot = file_snapshot(expected)

        environment = crash_environment("TARGET_TO_BACKUP_RENAMED")
        environment[MUTATE_SOURCE_ENV] = "MODIFY"
        result = run_publisher("RESUME", target, candidate, manifest, environment=environment)
        assert_killed(result, "TARGET_TO_BACKUP_RENAMED with source conflict")
        expect(not target.exists(), "source conflict crash did not stop after target rename")
        journal = read_journal(target)
        expect(journal["phase"] == "prepared", "source conflict crash persisted a false verification phase")
        backup = target.parent / str(journal["backup"])
        expect(file_snapshot(backup) == expected_snapshot, "crash backup lost the concurrent source")
        journal_temp = target.parent / f".{target.name}.lifecycle-journal-tmp-{'c' * 32}"
        journal_temp.write_text("interrupted journal temp\n", encoding="utf-8")

        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            SOURCE_CONFLICT_DIAGNOSTIC,
        )
        expect(target.is_dir(), "conflict recovery did not restore the official target")
        validate_workspace(target)
        expect(file_snapshot(target) == expected_snapshot, "conflict recovery restored the stale source")
        expect(file_snapshot(target) != candidate_snapshot, "conflict recovery promoted the candidate")
        expect(not transaction_residues(target), "conflict recovery left transaction residues")
        stable = file_snapshot(target)
        expect(not recover_incomplete_publication(target), "second conflict recovery was not a no-op")
        expect(file_snapshot(target) == stable, "second conflict recovery changed the source")
    return 1


def run_invalid_concurrent_source_cases() -> int:
    count = 0

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-invalid-source-live-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, _, _ = build_source_mutation_fixture(base)
        expected = base / "expected-invalid-source"
        shutil.copytree(target, expected, symlinks=True)
        apply_source_mutation_fixture(expected, "INVALID_SCHEMA")
        expected_snapshot = workspace_snapshot(expected)
        expected_feature = (expected / "feature_spec.md").read_bytes()

        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment={MUTATE_SOURCE_ENV: "INVALID_SCHEMA", ACK_ENV: ACK},
        )
        expect(result.returncode == 1, f"invalid source conflict publish rc={result.returncode}")
        expect(SOURCE_CONFLICT_DIAGNOSTIC in result.stderr, "invalid source conflict diagnostic is missing")
        expect(
            RESTORED_SOURCE_INVALID_DIAGNOSTIC in result.stderr,
            f"restored invalid-source diagnostic is missing: {result.stderr!r}",
        )
        expect(target.is_dir(), "temporarily invalid concurrent source was stranded in backup")
        expect(workspace_snapshot(target) == expected_snapshot, "invalid concurrent bytes/types were not restored")
        expect((target / "feature_spec.md").read_bytes() == expected_feature, "invalid feature bytes changed")
        expect(
            "R-002" not in (target / "shared/requirements.md").read_text(encoding="utf-8"),
            "candidate was promoted over the invalid concurrent source",
        )
        expect_validation_error(
            lambda: validate_workspace(target),
            "missing normalized File Purpose Header",
        )
        expect(not transaction_residues(target), "completed invalid-source rollback left residues")
        stable = workspace_snapshot(target)
        expect(not recover_incomplete_publication(target), "completed invalid-source rollback remained recoverable")
        expect(workspace_snapshot(target) == stable, "repeat recovery changed invalid concurrent bytes")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-invalid-source-recovery-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, _, _ = build_source_mutation_fixture(base)
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment=crash_environment("TARGET_TO_BACKUP_RENAMED"),
        )
        assert_killed(result, "TARGET_TO_BACKUP_RENAMED before invalid recovery")
        journal = read_journal(target)
        backup = target.parent / str(journal["backup"])
        backup_feature = backup / "feature_spec.md"
        backup_feature.unlink()
        backup_feature.symlink_to("execution/publisher-race/modified.txt")
        expected_snapshot = workspace_snapshot(backup)

        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            RESTORED_SOURCE_INVALID_DIAGNOSTIC,
        )
        expect(target.is_dir(), "invalid recovery left the official target absent")
        expect(workspace_snapshot(target) == expected_snapshot, "recovery changed invalid backup bytes/types")
        restored_feature = target / "feature_spec.md"
        expect(restored_feature.is_symlink(), "recovery changed the invalid feature entry type")
        expect(
            restored_feature.readlink() == Path("execution/publisher-race/modified.txt"),
            "recovery changed the invalid feature symlink target",
        )
        expect(not transaction_residues(target), "invalid recovery left transaction residues")
        stable = workspace_snapshot(target)
        expect(not recover_incomplete_publication(target), "second invalid recovery was not a no-op")
        expect(workspace_snapshot(target) == stable, "second invalid recovery changed official bytes")
    count += 1
    return count


def run_open_descriptor_boundary_case() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-open-fd-boundary-") as tmp:
        target, candidate, manifest, _, candidate_snapshot = build_source_mutation_fixture(Path(tmp))
        modified = target / "execution/publisher-race/modified.txt"
        descriptor = os.open(modified, os.O_WRONLY)
        try:
            result = run_publisher(
                "RESUME",
                target,
                candidate,
                manifest,
                environment=crash_environment("TARGET_TO_BACKUP_RENAMED"),
            )
            assert_killed(result, "TARGET_TO_BACKUP_RENAMED with open descriptor")
            expect(not target.exists(), "open-descriptor fixture did not stop after rename")

            # This write becomes visible after target -> backup but before the
            # first backup digest (which recovery performs).  The control proves
            # that interval only; it does not claim detection of writes through
            # an already-open descriptor after backup verification completed.
            os.ftruncate(descriptor, 0)
            os.write(descriptor, b"descriptor write after rename\n")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

        journal = read_journal(target)
        backup = target.parent / str(journal["backup"])
        expected_snapshot = workspace_snapshot(backup)
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            SOURCE_CONFLICT_DIAGNOSTIC,
        )
        expect(target.is_dir(), "open-descriptor edit was not restored to the official path")
        validate_workspace(target)
        expect(workspace_snapshot(target) == expected_snapshot, "open-descriptor edit bytes/types changed")
        expect(
            modified.read_bytes() == b"descriptor write after rename\n",
            "open-descriptor edit was lost",
        )
        expect(file_snapshot(target) != candidate_snapshot, "candidate replaced the open-descriptor edit")
        expect(not transaction_residues(target), "open-descriptor recovery left transaction residues")
        stable = workspace_snapshot(target)
        expect(not recover_incomplete_publication(target), "second open-descriptor recovery was not a no-op")
        expect(workspace_snapshot(target) == stable, "second open-descriptor recovery changed bytes")
    return 1


def run_identical_hardlink_swap_case() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-identical-hardlink-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, _, _ = build_source_mutation_fixture(base)
        victim = target / "execution/victim.txt"
        candidate_victim = candidate / "execution/victim.txt"
        external = base / "external-victim.txt"
        original_bytes = b"byte-identical hardlink payload\n"
        victim.write_bytes(original_bytes)
        candidate_victim.write_bytes(original_bytes)
        external.write_bytes(original_bytes)
        write_resume_manifest(
            manifest,
            target,
            feature_sections=("Requirements",),
            new_ids=("R-002",),
        )
        external_inode = external.stat().st_ino
        linked_state: dict[str, int] = {}

        def hardlink_swap() -> None:
            victim.unlink()
            os.link(external, victim)
            linked_state["inode"] = victim.stat().st_ino
            linked_state["nlink"] = victim.stat().st_nlink

        expect_validation_error(
            lambda: publish_candidate(
                "RESUME",
                target,
                candidate,
                manifest_path=manifest,
                before_publish=hardlink_swap,
            ),
            "source changed after candidate validation",
        )
        expect(linked_state, "hardlink swap hook did not execute")
        expect(target.is_dir(), "hardlink swap abort removed the official target")
        expect(victim.read_bytes() == original_bytes, "hardlink swap abort changed target bytes")
        expect(external.read_bytes() == original_bytes, "hardlink swap abort changed external bytes")
        expect(
            victim.stat().st_ino == linked_state["inode"] == external.stat().st_ino == external_inode,
            "hardlink swap abort did not preserve the concurrent inode relationship",
        )
        expect(
            victim.stat().st_nlink == linked_state["nlink"] == external.stat().st_nlink == 2,
            "hardlink swap abort did not preserve the concurrent link count",
        )
        expect(
            "R-002" not in (target / "shared/requirements.md").read_text(encoding="utf-8"),
            "candidate was promoted over the hardlink swap",
        )
        expect(not transaction_residues(target), "hardlink swap abort left transaction residues")
        stable = workspace_snapshot(target)
        expect(not recover_incomplete_publication(target), "hardlink swap abort remained recoverable")
        expect(workspace_snapshot(target) == stable, "no-op recovery changed hardlink topology")
        expect(external.stat().st_ino == external_inode, "no-op recovery replaced the external inode")
        expect(external.read_bytes() == original_bytes, "no-op recovery changed external bytes")
    return 1


def run_input_path_boundary_cases() -> int:
    count = 0

    def assert_inputs_unchanged(
        label: str,
        target: Path,
        candidate: Path,
        manifest: Path,
        target_snapshot: object,
        candidate_snapshot: object,
        manifest_bytes: bytes,
    ) -> None:
        expect(workspace_snapshot(target) == target_snapshot, f"{label}: target changed")
        expect(workspace_snapshot(candidate) == candidate_snapshot, f"{label}: candidate changed")
        expect(manifest.read_bytes() == manifest_bytes, f"{label}: manifest bytes changed")
        expect(
            "R-002" not in (target / "shared/requirements.md").read_text(encoding="utf-8"),
            f"{label}: candidate was promoted",
        )
        expect(not transaction_residues(target), f"{label}: lifecycle transaction residues remain")

    for input_name in ("target", "candidate", "manifest"):
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-{input_name}-ancestor-alias-") as tmp:
            base = Path(tmp)
            external_root = base / "external-root"
            target, candidate, manifest, _, _ = build_resume_fixture(external_root / "nested")
            alias = base / f"{input_name}-alias"
            alias.symlink_to(external_root, target_is_directory=True)
            target_snapshot = workspace_snapshot(target)
            candidate_snapshot = workspace_snapshot(candidate)
            manifest_bytes = manifest.read_bytes()
            target_inode = target.stat().st_ino
            feature_inode = (target / "feature_spec.md").stat().st_ino
            candidate_inode = candidate.stat().st_ino
            manifest_inode = manifest.stat().st_ino
            alias_inode = alias.lstat().st_ino

            requested_target = target
            requested_candidate = candidate
            requested_manifest = manifest
            if input_name == "target":
                requested_target = alias / "nested/workspace"
            elif input_name == "candidate":
                requested_candidate = alias / "nested/candidate"
            else:
                requested_manifest = alias / "nested/resume-manifest.json"

            diagnostic_label = "RESUME manifest" if input_name == "manifest" else input_name
            expect_validation_error(
                lambda: publish_candidate(
                    "RESUME",
                    requested_target,
                    requested_candidate,
                    manifest_path=requested_manifest,
                ),
                f"{diagnostic_label} must not contain symlink components",
            )
            assert_inputs_unchanged(
                f"nested {input_name} alias",
                target,
                candidate,
                manifest,
                target_snapshot,
                candidate_snapshot,
                manifest_bytes,
            )
            expect(target.stat().st_ino == target_inode, f"{input_name} alias: target inode changed")
            expect(
                (target / "feature_spec.md").stat().st_ino == feature_inode,
                f"{input_name} alias: target feature inode changed",
            )
            expect(candidate.stat().st_ino == candidate_inode, f"{input_name} alias: candidate inode changed")
            expect(manifest.stat().st_ino == manifest_inode, f"{input_name} alias: manifest inode changed")
            expect(alias.is_symlink() and alias.lstat().st_ino == alias_inode, f"{input_name} alias changed")
            expect(
                not lock_path(target).exists(),
                f"{input_name} alias rejection created a workspace lock",
            )
        count += 1

    for input_name in ("target", "candidate", "manifest"):
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-{input_name}-traversal-") as tmp:
            base = Path(tmp)
            target, candidate, manifest, _, _ = build_resume_fixture(base)
            detour = base / "detour"
            detour.mkdir()
            target_snapshot = workspace_snapshot(target)
            candidate_snapshot = workspace_snapshot(candidate)
            manifest_bytes = manifest.read_bytes()
            requested_target = target
            requested_candidate = candidate
            requested_manifest = manifest
            if input_name == "target":
                requested_target = detour / ".." / target.name
            elif input_name == "candidate":
                requested_candidate = detour / ".." / candidate.name
            else:
                requested_manifest = detour / ".." / manifest.name

            diagnostic_label = "RESUME manifest" if input_name == "manifest" else input_name
            expect_validation_error(
                lambda: publish_candidate(
                    "RESUME",
                    requested_target,
                    requested_candidate,
                    manifest_path=requested_manifest,
                ),
                f"{diagnostic_label} must not contain path traversal",
            )
            assert_inputs_unchanged(
                f"{input_name} traversal",
                target,
                candidate,
                manifest,
                target_snapshot,
                candidate_snapshot,
                manifest_bytes,
            )
            expect(
                not lock_path(target).exists(),
                f"{input_name} traversal rejection created a workspace lock",
            )
        count += 1

    return count


def run_recovery_before_late_input_validation_cases() -> int:
    count = 0
    for missing_input in ("candidate", "manifest"):
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-recover-missing-{missing_input}-") as tmp:
            base = Path(tmp)
            target, candidate, manifest, _, _ = build_resume_fixture(base)
            source_snapshot = workspace_snapshot(target)
            candidate_snapshot = workspace_snapshot(candidate)
            result = run_publisher(
                "RESUME",
                target,
                candidate,
                manifest,
                environment=crash_environment("TARGET_TO_BACKUP_RENAMED"),
            )
            assert_killed(result, f"TARGET_TO_BACKUP_RENAMED before missing {missing_input}")
            expect(not target.exists(), f"missing {missing_input}: crash did not remove official target")
            expect(journal_path(target).is_file(), f"missing {missing_input}: journal is absent")

            requested_candidate = candidate
            requested_manifest = manifest
            if missing_input == "candidate":
                requested_candidate = base / "missing-candidate"
                expected = "candidate must be a real directory"
            else:
                requested_manifest = base / "missing-resume-manifest.json"
                expected = "RESUME manifest must be a real file"

            expect_validation_error(
                lambda: publish_candidate(
                    "RESUME",
                    target,
                    requested_candidate,
                    manifest_path=requested_manifest,
                ),
                expected,
            )
            expect(target.is_dir(), f"missing {missing_input}: recovery did not restore target")
            validate_workspace(target)
            expect(
                workspace_snapshot(target) == source_snapshot,
                f"missing {missing_input}: recovery changed source bytes/types",
            )
            expect(
                workspace_snapshot(candidate) == candidate_snapshot,
                f"missing {missing_input}: late input failure changed valid candidate",
            )
            expect(
                "R-002" not in (target / "shared/requirements.md").read_text(encoding="utf-8"),
                f"missing {missing_input}: candidate was promoted",
            )
            expect(not transaction_residues(target), f"missing {missing_input}: residues remain")
            stable = workspace_snapshot(target)
            expect(not recover_incomplete_publication(target), f"missing {missing_input}: recovery repeated")
            expect(
                workspace_snapshot(target) == stable,
                f"missing {missing_input}: no-op recovery changed target",
            )
        count += 1
    return count


def run_static_input_preflight_cases() -> int:
    count = 0
    for case in ("overlap", "manifest-inside-candidate"):
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-static-{case}-") as tmp:
            base = Path(tmp)
            target, candidate, manifest, _, _ = build_resume_fixture(base)
            requested_candidate = candidate
            requested_manifest = manifest
            if case == "overlap":
                requested_candidate = target
                expected = "candidate and target must be disjoint directories"
            else:
                requested_manifest = candidate / "resume-manifest.json"
                shutil.copy2(manifest, requested_manifest)
                expected = "RESUME manifest must remain outside source and candidate workspaces"

            target_snapshot = workspace_snapshot(target)
            candidate_snapshot = workspace_snapshot(candidate)
            manifest_bytes = manifest.read_bytes()
            expect_validation_error(
                lambda: publish_candidate(
                    "RESUME",
                    target,
                    requested_candidate,
                    manifest_path=requested_manifest,
                ),
                expected,
            )
            expect(workspace_snapshot(target) == target_snapshot, f"{case}: target changed")
            expect(workspace_snapshot(candidate) == candidate_snapshot, f"{case}: candidate changed")
            expect(manifest.read_bytes() == manifest_bytes, f"{case}: manifest changed")
            expect(not lock_path(target).exists(), f"{case}: static preflight created a lock")
            expect(not transaction_residues(target), f"{case}: transaction residues remain")
        count += 1
    return count


def run_runtime_metadata_collision_matrix(
    *,
    case_variant: bool = False,
    parent_case_variant: bool = False,
    target_name: str = "workspace",
    namespace_target_name: str | None = None,
) -> int:
    count = 0
    for input_name in ("candidate", "manifest"):
        for reserved_kind in ("journal", "lock", "stage", "backup", "journal-temp"):
            with tempfile.TemporaryDirectory(
                prefix=f"stnl-publisher-{input_name}-{reserved_kind}-collision-"
            ) as tmp:
                base = Path(tmp)
                fixture_base = base / "ParentCase" if parent_case_variant else base
                target, candidate, manifest, _, _ = build_resume_fixture(
                    fixture_base,
                    target_name=target_name,
                )
                runtime_target_name = namespace_target_name or target.name
                reserved_paths = {
                    "journal": target.parent
                    / f".{runtime_target_name}.lifecycle-transaction.json",
                    "lock": target.parent / f".{runtime_target_name}.lifecycle.lock",
                    "stage": target.parent / f".{runtime_target_name}.lifecycle-stage-collision",
                    "backup": target.parent / f".{runtime_target_name}.lifecycle-backup-collision",
                    "journal-temp": target.parent
                    / f".{runtime_target_name}.lifecycle-journal-tmp-collision",
                }
                collision = reserved_paths[reserved_kind]
                if case_variant:
                    collision = collision.with_name(collision.name.swapcase())
                collision_parent = target.parent
                if parent_case_variant:
                    collision_parent = target.parent.with_name(target.parent.name.lower())
                    if not collision_parent.exists():
                        collision_parent.mkdir()
                    collision = collision_parent / collision.name
                requested_candidate = candidate
                requested_manifest = manifest
                if input_name == "candidate":
                    shutil.copytree(candidate, collision)
                    requested_candidate = collision
                    input_snapshot: object = workspace_snapshot(collision)
                    input_bytes: bytes | None = None
                else:
                    shutil.copy2(manifest, collision)
                    requested_manifest = collision
                    input_snapshot = None
                    input_bytes = collision.read_bytes()

                label = "RESUME manifest" if input_name == "manifest" else input_name
                parent_snapshot = workspace_snapshot(target.parent)
                collision_parent_snapshot = workspace_snapshot(collision_parent)
                target_snapshot = workspace_snapshot(target)
                input_inode = collision.lstat().st_ino
                residues_before = transaction_residues(target)
                lock_existed_before = lock_path(target).exists()
                expect_validation_error(
                    lambda: publish_candidate(
                        "RESUME",
                        target,
                        requested_candidate,
                        manifest_path=requested_manifest,
                    ),
                    f"{label} collides with target-owned publisher runtime metadata namespace",
                )
                expect(
                    workspace_snapshot(target.parent) == parent_snapshot,
                    f"{input_name}/{reserved_kind}: publisher changed sibling inputs",
                )
                expect(
                    workspace_snapshot(collision_parent) == collision_parent_snapshot,
                    f"{input_name}/{reserved_kind}: publisher changed case-variant parent inputs",
                )
                expect(
                    collision.lstat().st_ino == input_inode,
                    f"{input_name}/{reserved_kind}: colliding input inode changed",
                )
                if input_name == "candidate":
                    expect(collision.is_dir(), f"candidate/{reserved_kind}: input changed type")
                    expect(
                        workspace_snapshot(collision) == input_snapshot,
                        f"candidate/{reserved_kind}: input bytes/types changed",
                    )
                else:
                    expect(collision.is_file(), f"manifest/{reserved_kind}: input changed type")
                    expect(
                        collision.read_bytes() == input_bytes,
                        f"manifest/{reserved_kind}: input bytes changed",
                    )
                expect(
                    workspace_snapshot(target) == target_snapshot,
                    f"{input_name}/{reserved_kind}: target changed",
                )
                expect(
                    "R-002" not in (target / "shared/requirements.md").read_text(encoding="utf-8"),
                    f"{input_name}/{reserved_kind}: candidate was promoted",
                )
                expect(
                    transaction_residues(target) == residues_before,
                    f"{input_name}/{reserved_kind}: publisher created transaction residues",
                )
                expect(
                    lock_path(target).exists() == lock_existed_before,
                    f"{input_name}/{reserved_kind}: publisher created a lock",
                )
            count += 1
    return count


def run_casefold_runtime_metadata_collision_matrix() -> int:
    return run_runtime_metadata_collision_matrix(case_variant=True)


def run_parent_casefold_runtime_metadata_collision_matrix() -> int:
    return run_runtime_metadata_collision_matrix(parent_case_variant=True)


def run_unicode_runtime_metadata_collision_matrix() -> int:
    nfd_target = "Cafe\u0301"
    nfc_target = "Caf\u00e9"
    exact = run_runtime_metadata_collision_matrix(
        target_name=nfd_target,
        namespace_target_name=nfd_target,
    )
    equivalent = run_runtime_metadata_collision_matrix(
        target_name=nfd_target,
        namespace_target_name=nfc_target,
    )
    return exact + equivalent


def run_casefold_samefile_disjoint_case() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-casefold-samefile-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, _, _ = build_resume_fixture(base / "ParentCase")
        requested_candidate = base / "parentcase/WORKSPACE"
        if not requested_candidate.exists():
            return 0
        expect(
            os.path.samefile(target, requested_candidate),
            "casefold samefile fixture does not address the physical target",
        )
        target_snapshot = workspace_snapshot(target)
        candidate_snapshot = workspace_snapshot(candidate)
        parent_snapshot = workspace_snapshot(target.parent)
        manifest_bytes = manifest.read_bytes()
        target_inode = target.stat().st_ino
        feature_inode = (target / "feature_spec.md").stat().st_ino

        expect_validation_error(
            lambda: publish_candidate(
                "RESUME",
                target,
                requested_candidate,
                manifest_path=manifest,
            ),
            "candidate and target must be disjoint directories",
        )
        expect(target.stat().st_ino == target_inode, "casefold samefile target inode changed")
        expect(
            requested_candidate.stat().st_ino == target_inode,
            "casefold samefile candidate stopped addressing the target",
        )
        expect(
            (target / "feature_spec.md").stat().st_ino == feature_inode,
            "casefold samefile feature inode changed",
        )
        expect(workspace_snapshot(target) == target_snapshot, "casefold samefile target changed")
        expect(workspace_snapshot(candidate) == candidate_snapshot, "casefold samefile seed changed")
        expect(workspace_snapshot(target.parent) == parent_snapshot, "casefold samefile parent changed")
        expect(manifest.read_bytes() == manifest_bytes, "casefold samefile manifest changed")
        expect(
            "R-002" not in (target / "shared/requirements.md").read_text(encoding="utf-8"),
            "casefold samefile candidate was published",
        )
        expect(not lock_path(target).exists(), "casefold samefile rejection created a lock")
        expect(not transaction_residues(target), "casefold samefile rejection created residues")
    return 1


def run_inconsistent_state_cases() -> int:
    count = 0

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-invalid-stage-") as tmp:
        target, candidate, manifest, source_snapshot, _ = build_resume_fixture(Path(tmp))
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment=crash_environment("JOURNAL_PREPARED"),
        )
        assert_killed(result, "JOURNAL_PREPARED")
        journal = read_journal(target)
        stage = target.parent / str(journal["stage"])
        (stage / "feature_spec.md").write_text("invalid staged workspace\n", encoding="utf-8")
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "feature_spec.md",
        )
        expect(file_snapshot(target) == source_snapshot, "invalid stage replaced the source")
        expect(stage.exists(), "invalid stage was destroyed despite blocked diagnostic recovery")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-missing-stage-") as tmp:
        target, candidate, manifest, source_snapshot, _ = build_resume_fixture(Path(tmp))
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment=crash_environment("JOURNAL_PREPARED"),
        )
        assert_killed(result, "JOURNAL_PREPARED")
        stage = target.parent / str(read_journal(target)["stage"])
        shutil.rmtree(stage)
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "no recoverable source/stage layout",
        )
        expect(file_snapshot(target) == source_snapshot, "missing journal paths changed source")
        expect(journal_path(target).exists(), "inconsistent journal was silently removed")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-orphan-stage-") as tmp:
        target, candidate, _, source_snapshot, _ = build_resume_fixture(Path(tmp))
        orphan = target.parent / f".{target.name}.lifecycle-stage-{'a' * 32}"
        shutil.copytree(candidate, orphan)
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "orphan publisher residues",
        )
        expect(file_snapshot(target) == source_snapshot, "orphan stage was promoted")
        expect(orphan.exists(), "orphan stage was removed without journal authority")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-orphan-backup-") as tmp:
        target, _, _, source_snapshot, _ = build_resume_fixture(Path(tmp))
        orphan = target.parent / f".{target.name}.lifecycle-backup-{'b' * 32}"
        shutil.copytree(target, orphan)
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "orphan publisher residues",
        )
        expect(file_snapshot(target) == source_snapshot, "orphan backup changed target")
        expect(orphan.exists(), "orphan backup was deleted without journal authority")
    count += 1
    return count


def run_journal_security_cases() -> int:
    count = 0

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-malformed-journal-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        write_full_workspace(target, "ready")
        source_snapshot = file_snapshot(target)
        journal_path(target).write_text("{malformed\n", encoding="utf-8")
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "journal is malformed",
        )
        expect(file_snapshot(target) == source_snapshot, "malformed journal changed target")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-duplicate-journal-key-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        write_full_workspace(target, "ready")
        source_snapshot = file_snapshot(target)
        journal_path(target).write_text('{"version": 1, "version": 1}\n', encoding="utf-8")
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "duplicate JSON key 'version'",
        )
        expect(file_snapshot(target) == source_snapshot, "duplicate journal key changed target")
    count += 1

    for label, observed, phase, diagnostic in (
        ("malformed", "not-a-digest", "rollback_required", "invalid observed source snapshot digest"),
        ("wrong-phase", "0" * 64, "prepared", "valid only while rollback is required"),
    ):
        with tempfile.TemporaryDirectory(prefix=f"stnl-publisher-observed-{label}-") as tmp:
            target, candidate, manifest, source_snapshot, _ = build_resume_fixture(Path(tmp))
            result = run_publisher(
                "RESUME",
                target,
                candidate,
                manifest,
                environment=crash_environment("JOURNAL_PREPARED"),
            )
            assert_killed(result, "JOURNAL_PREPARED")
            payload = read_journal(target)
            payload["observed_source_snapshot_sha256"] = observed
            payload["phase"] = phase
            journal_path(target).write_text(json.dumps(payload) + "\n", encoding="utf-8")
            expect_validation_error(
                lambda: recover_incomplete_publication(target),
                diagnostic,
            )
            expect(file_snapshot(target) == source_snapshot, f"{label} observed digest changed target")
        count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-rejected-v1-journal-") as tmp:
        target, candidate, manifest, source_snapshot, _ = build_resume_fixture(Path(tmp))
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment=crash_environment("JOURNAL_PREPARED"),
        )
        assert_killed(result, "JOURNAL_PREPARED")
        payload = read_journal(target)
        payload["version"] = 1
        payload.pop("observed_source_snapshot_sha256")
        journal_path(target).write_text(json.dumps(payload) + "\n", encoding="utf-8")
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "unsupported transaction journal version 1",
        )
        expect(file_snapshot(target) == source_snapshot, "rejected v1 journal changed source")
        expect(journal_path(target).is_file(), "rejected v1 journal was removed")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-traversal-journal-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, source_snapshot, _ = build_resume_fixture(base)
        outside = base / "outside.txt"
        outside.write_text("external sentinel\n", encoding="utf-8")
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment=crash_environment("JOURNAL_PREPARED"),
        )
        assert_killed(result, "JOURNAL_PREPARED")
        payload = read_journal(target)
        payload["stage"] = "../outside.txt"
        journal_path(target).write_text(json.dumps(payload) + "\n", encoding="utf-8")
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "stage is not the transaction-owned sibling path",
        )
        expect(outside.read_text(encoding="utf-8") == "external sentinel\n", "traversal changed external file")
        expect(file_snapshot(target) == source_snapshot, "traversal journal changed target")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-journal-symlink-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        outside = base / "outside.json"
        write_full_workspace(target, "ready")
        source_snapshot = file_snapshot(target)
        outside.write_text("external sentinel\n", encoding="utf-8")
        journal_path(target).symlink_to(outside)
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "journal must not be a symlink",
        )
        expect(outside.read_text(encoding="utf-8") == "external sentinel\n", "journal symlink changed external file")
        expect(file_snapshot(target) == source_snapshot, "journal symlink changed target")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-journal-hardlink-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, source_snapshot, _ = build_resume_fixture(base)
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment=crash_environment("JOURNAL_PREPARED"),
        )
        assert_killed(result, "JOURNAL_PREPARED")
        journal = journal_path(target)
        stage = target.parent / str(read_journal(target)["stage"])
        outside = base / "external-journal-link.json"
        expected_journal = journal.read_bytes()
        os.link(journal, outside)
        linked_inode = journal.stat().st_ino

        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "journal must be a single-link regular file",
        )
        expect(file_snapshot(target) == source_snapshot, "journal hardlink changed target")
        expect(journal.is_file() and outside.is_file(), "journal hardlink rejection removed a link")
        expect(stage.is_dir(), "journal hardlink rejection removed transaction evidence")
        expect(journal.read_bytes() == expected_journal, "journal hardlink rejection changed journal bytes")
        expect(outside.read_bytes() == expected_journal, "journal hardlink rejection changed external bytes")
        expect(
            journal.stat().st_ino == linked_inode == outside.stat().st_ino,
            "journal hardlink rejection replaced a linked inode",
        )
        expect(journal.stat().st_nlink == 2, "journal hardlink rejection changed the link count")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-stage-symlink-") as tmp:
        base = Path(tmp)
        target, candidate, manifest, source_snapshot, _ = build_resume_fixture(base)
        outside = base / "outside"
        outside.mkdir()
        sentinel = outside / "sentinel.txt"
        sentinel.write_text("external sentinel\n", encoding="utf-8")
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment=crash_environment("JOURNAL_PREPARED"),
        )
        assert_killed(result, "JOURNAL_PREPARED")
        stage = target.parent / str(read_journal(target)["stage"])
        shutil.rmtree(stage)
        stage.symlink_to(outside, target_is_directory=True)
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "stage must not be a symlink",
        )
        expect(sentinel.read_text(encoding="utf-8") == "external sentinel\n", "stage symlink changed external data")
        expect(file_snapshot(target) == source_snapshot, "stage symlink changed target")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-lock-symlink-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        outside = base / "outside.lock"
        write_full_workspace(target, "ready")
        source_snapshot = file_snapshot(target)
        outside.write_text("external sentinel\n", encoding="utf-8")
        lock_path(target).symlink_to(outside)
        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "lock must not be a symlink",
        )
        expect(outside.read_text(encoding="utf-8") == "external sentinel\n", "lock symlink changed external file")
        expect(file_snapshot(target) == source_snapshot, "lock symlink changed target")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-lock-hardlink-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        outside = base / "external.lock"
        lock = lock_path(target)
        write_full_workspace(target, "ready")
        source_snapshot = file_snapshot(target)
        outside.write_text("external lock sentinel\n", encoding="utf-8")
        os.link(outside, lock)
        linked_inode = outside.stat().st_ino

        expect_validation_error(
            lambda: recover_incomplete_publication(target),
            "lock must be a single-link regular file",
        )
        expect(file_snapshot(target) == source_snapshot, "lock hardlink changed target")
        expect(lock.is_file() and outside.is_file(), "lock hardlink rejection removed a link")
        expect(
            outside.read_text(encoding="utf-8") == "external lock sentinel\n",
            "lock hardlink rejection changed external bytes",
        )
        expect(
            lock.stat().st_ino == linked_inode == outside.stat().st_ino,
            "lock hardlink rejection replaced a linked inode",
        )
        expect(lock.stat().st_nlink == 2, "lock hardlink rejection changed the link count")
    count += 1
    return count


def run_manifest_and_hook_contract_cases() -> int:
    count = 0

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-manifest-contract-") as tmp:
        target, candidate, manifest, source_snapshot, _ = build_resume_fixture(Path(tmp))
        expect_validation_error(
            lambda: publish_candidate("RESUME", target, candidate),
            "requires --manifest PATH",
        )
        expect(file_snapshot(target) == source_snapshot, "missing manifest changed target")

        inside_manifest = candidate / "resume-manifest.json"
        shutil.copy2(manifest, inside_manifest)
        expect_validation_error(
            lambda: publish_candidate("RESUME", target, candidate, manifest_path=inside_manifest),
            "outside source and candidate workspaces",
        )
        expect(file_snapshot(target) == source_snapshot, "persistable manifest changed target")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-nonresume-manifest-") as tmp:
        base = Path(tmp)
        target = base / "workspace"
        candidate = base / "candidate"
        manifest = base / "manifest.json"
        write_full_workspace(candidate, "ready")
        manifest.write_text("{}\n", encoding="utf-8")
        expect_validation_error(
            lambda: publish_candidate("INIT", target, candidate, manifest_path=manifest),
            "valid only for RESUME",
        )
        expect(not target.exists(), "INIT accepted/persisted an out-of-contract manifest")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-cli-manifest-") as tmp:
        target, candidate, _, source_snapshot, _ = build_resume_fixture(Path(tmp))
        result = run_publisher("RESUME", target, candidate)
        expect(result.returncode == 1, f"CLI accepted RESUME without manifest: {result}")
        expect("requires --manifest PATH" in result.stderr, f"CLI gave wrong manifest diagnostic: {result.stderr!r}")
        expect(file_snapshot(target) == source_snapshot, "CLI missing manifest changed target")
    count += 1

    with tempfile.TemporaryDirectory(prefix="stnl-publisher-hook-guard-") as tmp:
        target, candidate, manifest, source_snapshot, _ = build_resume_fixture(Path(tmp))
        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment={CRASH_ENV: "JOURNAL_PREPARED"},
        )
        expect(result.returncode == 1, f"unacknowledged crash hook activated: rc={result.returncode}")
        expect("exact isolated-crash acknowledgement" in result.stderr, "wrong hook guard diagnostic")
        expect(file_snapshot(target) == source_snapshot, "unacknowledged hook changed target")
        expect(not transaction_residues(target), "unacknowledged hook created transaction residues")

        result = run_publisher(
            "RESUME",
            target,
            candidate,
            manifest,
            environment={MUTATE_SOURCE_ENV: "ADD"},
        )
        expect(result.returncode == 1, f"unacknowledged mutation hook activated: rc={result.returncode}")
        expect("exact isolated-crash acknowledgement" in result.stderr, "wrong mutation hook guard diagnostic")
        expect(file_snapshot(target) == source_snapshot, "unacknowledged mutation hook changed target")
        expect(not transaction_residues(target), "unacknowledged mutation hook created residues")
    count += 1
    return count


def run_concurrency_case() -> int:
    with tempfile.TemporaryDirectory(prefix="stnl-publisher-race-") as tmp:
        target, candidate, manifest, _, candidate_snapshot = build_resume_fixture(Path(tmp))
        entered = threading.Event()
        release = threading.Event()
        failures: list[BaseException] = []

        def hold_before_publication() -> None:
            entered.set()
            if not release.wait(timeout=15):
                raise RuntimeError("race test timed out while holding publisher lock")

        def first_publisher() -> None:
            try:
                publish_candidate(
                    "RESUME",
                    target,
                    candidate,
                    manifest_path=manifest,
                    before_publish=hold_before_publication,
                )
            except BaseException as exc:  # pragma: no cover - reported below
                failures.append(exc)

        thread = threading.Thread(target=first_publisher, name="publisher-lock-holder")
        thread.start()
        expect(entered.wait(timeout=15), "first publisher never acquired/held the lock")
        try:
            competing = run_publisher("RESUME", target, candidate, manifest)
            expect(competing.returncode == 1, f"competing publisher was not rejected: {competing}")
            expect("already holds the workspace lock" in competing.stderr, "wrong race diagnostic")
        finally:
            release.set()
            thread.join(timeout=15)
        expect(not thread.is_alive(), "first publisher did not finish after race release")
        expect(not failures, f"first publisher failed after rejecting the race: {failures!r}")
        expect(file_snapshot(target) == candidate_snapshot, "winning publisher did not publish exact candidate")
        validate_workspace(target)
        expect(not transaction_residues(target), "race left transaction residues")
    return 1


def main() -> int:
    groups = (
        ("crash checkpoints", run_crash_checkpoint_matrix),
        ("INIT recovery", run_init_recovery_cases),
        ("RESUME recovery and retry", run_resume_retry_integration),
        ("CLOSE renderer recovery and retry", run_close_renderer_recovery_integration),
        ("CLOSE recovery without ephemeral attestation", run_close_recovery_without_ephemeral_attestation_cases),
        ("CLOSE stale attestation after valid whitespace", run_close_stale_attestation_whitespace_case),
        ("CLOSE noncanonical candidate whitespace", run_close_noncanonical_candidate_whitespace_case),
        ("CLOSE candidate OS metadata", run_close_candidate_os_metadata_cases),
        ("CLOSE journaled OS metadata recovery", run_close_journaled_os_metadata_recovery_cases),
        ("readiness attestation publisher contracts", run_readiness_attestation_publisher_contract_cases),
        ("readiness attestation path preflight", run_readiness_attestation_path_preflight_cases),
        ("readiness attestation runtime collisions", run_readiness_attestation_runtime_metadata_collision_matrix),
        (
            "Unicode readiness attestation runtime collisions",
            run_unicode_readiness_attestation_runtime_metadata_collision_matrix,
        ),
        ("candidate validation baselines", run_candidate_validation_baseline_cases),
        ("final-window source changes", run_final_window_source_change_cases),
        ("final-window crash recovery", run_final_window_crash_recovery_case),
        ("temporarily invalid concurrent source", run_invalid_concurrent_source_cases),
        ("open-descriptor temporal boundary", run_open_descriptor_boundary_case),
        ("byte-identical hardlink swap", run_identical_hardlink_swap_case),
        ("publisher input path boundaries", run_input_path_boundary_cases),
        ("static publisher input preflight", run_static_input_preflight_cases),
        ("runtime metadata collision matrix", run_runtime_metadata_collision_matrix),
        ("casefold runtime metadata collisions", run_casefold_runtime_metadata_collision_matrix),
        ("parent-case runtime metadata collisions", run_parent_casefold_runtime_metadata_collision_matrix),
        ("Unicode runtime metadata collisions", run_unicode_runtime_metadata_collision_matrix),
        ("casefold samefile disjointness", run_casefold_samefile_disjoint_case),
        ("recovery before late input validation", run_recovery_before_late_input_validation_cases),
        ("inconsistent states", run_inconsistent_state_cases),
        ("journal security", run_journal_security_cases),
        ("manifest and hook contracts", run_manifest_and_hook_contract_cases),
        ("workspace race", run_concurrency_case),
    )
    total = 0
    for label, runner in groups:
        count = runner()
        total += count
        print(f"PASS: {label} ({count} cases)")
    print(f"PASS: publisher recovery suite ({total} cases, {len(CHECKPOINTS)} SIGKILL checkpoints)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
