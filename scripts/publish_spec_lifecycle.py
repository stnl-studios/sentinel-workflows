#!/usr/bin/env python3
"""Validate, durably publish, and recover mutable SPEC lifecycle candidates.

The publisher uses atomic same-directory renames plus a durable transaction
journal.  Those primitives support deterministic recovery after interruption;
they do not imply filesystem-wide or hardware-level absolute atomicity.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import sys
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Iterator

from build_closed_spec import render_closed_feature
from create_readiness_attestation import validate_readiness_attestation
from validate_spec_lifecycle import (
    ValidationError,
    canonical_path_without_symlinks,
    filesystem_component_key,
    is_os_metadata,
    validate_close_transition,
    validate_init_transition,
    validate_resume_transition,
    validate_workspace,
    workspace_snapshot,
)


MUTABLE_MODES = {"INIT", "RESUME", "CLOSE"}
JOURNAL_VERSION = 2
PHASE_PREPARED = "prepared"
PHASE_BACKUP_CREATED = "backup_created"
PHASE_BACKUP_VERIFIED = "backup_verified"
PHASE_CANDIDATE_PROMOTED = "candidate_promoted"
PHASE_CANDIDATE_VALIDATED = "candidate_validated"
PHASE_COMMITTED = "committed"
PHASE_ROLLBACK_REQUIRED = "rollback_required"
TRANSACTION_PHASES = {
    PHASE_PREPARED,
    PHASE_BACKUP_CREATED,
    PHASE_BACKUP_VERIFIED,
    PHASE_CANDIDATE_PROMOTED,
    PHASE_CANDIDATE_VALIDATED,
    PHASE_COMMITTED,
    PHASE_ROLLBACK_REQUIRED,
}

_DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}")
_TRANSACTION_ID_PATTERN = re.compile(r"[0-9a-f]{32}")
_MAX_JOURNAL_BYTES = 64 * 1024
_DIRECTORY_FSYNC_UNSUPPORTED = {
    errno.EBADF,
    errno.EINVAL,
    getattr(errno, "ENOTSUP", errno.EINVAL),
    getattr(errno, "EOPNOTSUPP", errno.EINVAL),
}

# These hooks exist solely for subprocess crash tests.  Both the deliberately
# alarming variable names and the exact acknowledgement are required, and the
# hooks are inert by default.
_TEST_ONLY_CRASH_ENV = "STNL_PUBLISHER_TEST_ONLY_CRASH_AT_CHECKPOINT"
_TEST_ONLY_FORCE_ROLLBACK_ENV = "STNL_PUBLISHER_TEST_ONLY_FORCE_ROLLBACK"
_TEST_ONLY_MUTATE_SOURCE_ENV = (
    "STNL_PUBLISHER_TEST_ONLY_MUTATE_SOURCE_BEFORE_BACKUP_RENAME"
)
_TEST_ONLY_ACK_ENV = "STNL_PUBLISHER_TEST_ONLY_ACKNOWLEDGE_PROCESS_KILL"
_TEST_ONLY_ACK = "YES_THIS_IS_AN_ISOLATED_PUBLISHER_CRASH_TEST"
_TEST_ONLY_CHECKPOINTS = {
    "JOURNAL_PREPARED",
    "TARGET_TO_BACKUP_RENAMED",
    "STAGE_TO_TARGET_RENAMED",
    "BEFORE_TARGET_VALIDATION",
    "AFTER_TARGET_VALIDATION",
    "BEFORE_BACKUP_REMOVAL",
    "DURING_ROLLBACK",
}
_TEST_ONLY_SOURCE_MUTATIONS = {
    "ADD",
    "MODIFY",
    "REMOVE",
    "SYMLINK",
    "INVALID_SCHEMA",
}
_TEST_ONLY_MUTATION_DIRECTORY = Path("execution/publisher-race")
_SOURCE_CONFLICT_DIAGNOSTIC = (
    "source changed during publish; publication aborted; concurrent source preserved"
)
_RESTORED_SOURCE_INVALID_DIAGNOSTIC = (
    "official target restored but workspace validation failed"
)


@dataclass(frozen=True)
class Transaction:
    mode: str
    target_name: str
    stage_name: str
    backup_name: str | None
    phase: str
    source_snapshot_sha256: str | None
    candidate_snapshot_sha256: str
    observed_source_snapshot_sha256: str | None
    transaction_id: str

    def payload(self) -> dict[str, object]:
        return {
            "version": JOURNAL_VERSION,
            "mode": self.mode,
            "target": self.target_name,
            "stage": self.stage_name,
            "backup": self.backup_name,
            "phase": self.phase,
            "source_snapshot_sha256": self.source_snapshot_sha256,
            "candidate_snapshot_sha256": self.candidate_snapshot_sha256,
            "observed_source_snapshot_sha256": self.observed_source_snapshot_sha256,
            "transaction_id": self.transaction_id,
        }


@dataclass(frozen=True)
class RollbackOutcome:
    source_conflict: bool = False
    restored_validation_error: str | None = None


@dataclass
class CandidateLinkGroup:
    first_stage_path: Path
    source_link_count: int
    seen: int
    kind: str


def _fail(message: str, path: Path | None = None) -> None:
    if path is None:
        raise ValidationError(message)
    raise ValidationError(f"{message}: {path}")


def _lexists(path: Path) -> bool:
    return os.path.lexists(path)


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def _copy_candidate_entry(
    source: Path,
    destination: Path,
    link_groups: dict[tuple[int, int], CandidateLinkGroup],
) -> None:
    metadata = source.lstat()
    mode = metadata.st_mode
    if stat.S_ISLNK(mode) or stat.S_ISREG(mode):
        kind = "symlink" if stat.S_ISLNK(mode) else "file"
        link_key = (metadata.st_dev, metadata.st_ino)
        group = link_groups.get(link_key) if metadata.st_nlink > 1 else None
        if group is not None:
            if group.source_link_count != metadata.st_nlink or group.kind != kind:
                _fail("candidate hardlink group changed while staging", source)
            os.link(group.first_stage_path, destination, follow_symlinks=False)
            group.seen += 1
            return
    if stat.S_ISLNK(mode):
        os.symlink(os.readlink(source), destination)
        if metadata.st_nlink > 1:
            link_groups[link_key] = CandidateLinkGroup(
                destination,
                metadata.st_nlink,
                1,
                kind,
            )
        return
    if stat.S_ISREG(mode):
        shutil.copy2(source, destination, follow_symlinks=False)
        if metadata.st_nlink > 1:
            link_groups[link_key] = CandidateLinkGroup(
                destination,
                metadata.st_nlink,
                1,
                kind,
            )
        return
    if stat.S_ISDIR(mode):
        destination.mkdir()
        for child in sorted(source.iterdir(), key=lambda path: path.name):
            _copy_candidate_entry(child, destination / child.name, link_groups)
        shutil.copystat(source, destination, follow_symlinks=False)
        return
    _fail("candidate contains an unsupported filesystem entry", source)


def _copy_candidate_tree(candidate: Path, stage: Path) -> None:
    if any(stage.iterdir()):
        _fail("transaction-owned stage must be empty before candidate copy", stage)
    link_groups: dict[tuple[int, int], CandidateLinkGroup] = {}
    for child in sorted(candidate.iterdir(), key=lambda path: path.name):
        _copy_candidate_entry(child, stage / child.name, link_groups)
    for group in link_groups.values():
        if group.seen != group.source_link_count:
            _fail("candidate hardlink group crosses the publication boundary", candidate)
        if group.first_stage_path.lstat().st_nlink != group.source_link_count:
            _fail("staged candidate hardlink topology changed during copy", stage)
    shutil.copystat(candidate, stage, follow_symlinks=False)


def _fsync_fd(fd: int, *, directory: bool = False) -> None:
    try:
        os.fsync(fd)
    except OSError as exc:
        if directory and exc.errno in _DIRECTORY_FSYNC_UNSUPPORTED:
            return
        raise


def _open_nofollow(path: Path, flags: int, mode: int | None = None) -> int:
    safe_flags = flags | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        if mode is None:
            return os.open(path, safe_flags)
        return os.open(path, safe_flags, mode)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            _fail("refusing to follow a symlink", path)
        raise


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    try:
        fd = _open_nofollow(path, flags)
    except OSError as exc:
        if exc.errno in _DIRECTORY_FSYNC_UNSUPPORTED:
            return
        raise
    try:
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            _fail("expected a real directory for durability synchronization", path)
        _fsync_fd(fd, directory=True)
    finally:
        os.close(fd)


def _fsync_tree(root: Path) -> None:
    files: list[Path] = []
    directories: list[Path] = [root]
    for path in root.rglob("*"):
        if path.is_symlink():
            continue
        if path.is_file():
            files.append(path)
        elif path.is_dir():
            directories.append(path)

    for path in sorted(files, key=lambda value: value.as_posix()):
        fd = _open_nofollow(path, os.O_RDONLY)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                _fail("staged file changed type while synchronizing", path)
            _fsync_fd(fd)
        finally:
            os.close(fd)
    for path in sorted(directories, key=lambda value: len(value.parts), reverse=True):
        _fsync_directory(path)


def _durable_replace(source: Path, destination: Path) -> None:
    if source.parent != destination.parent:
        _fail("critical publication renames must remain in one parent directory")
    if _lexists(destination):
        _fail("critical rename destination unexpectedly exists", destination)
    os.replace(source, destination)
    _fsync_directory(destination.parent)


def _durable_remove(path: Path) -> None:
    if not _lexists(path):
        return
    if path.is_symlink():
        _fail("refusing to remove a transaction path that became a symlink", path)
    _remove_path(path)
    _fsync_directory(path.parent)


def _snapshot_digest(root: Path) -> str:
    encoded = json.dumps(
        workspace_snapshot(root),
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _reject_close_candidate_metadata(root: Path) -> None:
    forbidden = sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if is_os_metadata(path.relative_to(root))
    )
    if forbidden:
        _fail(
            f"CLOSE candidate contains OS metadata absent from deterministic rendering: {forbidden}",
            root,
        )


def _require_candidate_snapshot(
    path: Path,
    expected_digest: str,
    mode: str,
    mismatch: str,
) -> None:
    if mode == "CLOSE":
        _reject_close_candidate_metadata(path)
    if _snapshot_digest(path) != expected_digest:
        _fail(mismatch, path)


def _journal_path(target: Path) -> Path:
    return target.parent / f".{target.name}.lifecycle-transaction.json"


def _lock_path(target: Path) -> Path:
    return target.parent / f".{target.name}.lifecycle.lock"


def _journal_temp_prefix(target: Path) -> str:
    return f".{target.name}.lifecycle-journal-tmp-"


def _stage_prefix(target: Path) -> str:
    return f".{target.name}.lifecycle-stage-"


def _backup_prefix(target: Path) -> str:
    return f".{target.name}.lifecycle-backup-"


def _normalize_target(target: str | Path) -> Path:
    requested = Path(target).expanduser()
    if requested.name in {"", ".", ".."}:
        _fail("target must name a workspace directory", requested)
    if requested.is_symlink():
        _fail("target must not be a symlink", requested)
    normalized = canonical_path_without_symlinks(requested, "target")
    parent = normalized.parent
    if parent.is_symlink() or not parent.is_dir():
        _fail("target parent must be a real directory", parent)
    return normalized


def _preflight_candidate_path(candidate: str | Path) -> Path:
    requested = Path(candidate).expanduser()
    if requested.is_symlink():
        _fail("candidate must not be a symlink", requested)
    return canonical_path_without_symlinks(requested, "candidate")


def _preflight_manifest_path(
    mode: str,
    manifest_path: str | Path | None,
    target: Path,
    candidate: Path,
) -> Path | None:
    if mode != "RESUME":
        if manifest_path is not None:
            _fail(f"--manifest is valid only for RESUME, not {mode}")
        return None
    if manifest_path is None:
        _fail("RESUME publication requires --manifest PATH")

    requested = Path(manifest_path).expanduser()
    if requested.is_symlink():
        _fail("RESUME manifest must not be a symlink", requested)
    manifest = canonical_path_without_symlinks(requested, "RESUME manifest")
    if manifest.is_relative_to(target) or manifest.is_relative_to(candidate):
        _fail("RESUME manifest must remain outside source and candidate workspaces", manifest)
    return manifest


def _preflight_readiness_attestation_path(
    mode: str,
    readiness_attestation: str | Path | None,
    target: Path,
    candidate: Path,
) -> Path | None:
    if mode != "CLOSE":
        if readiness_attestation is not None:
            _fail(f"--readiness-attestation is valid only for CLOSE, not {mode}")
        return None
    if readiness_attestation is None:
        _fail("CLOSE publication requires --readiness-attestation PATH")

    requested = Path(readiness_attestation).expanduser()
    if requested.is_symlink():
        _fail("readiness attestation must not be a symlink", requested)
    attestation = canonical_path_without_symlinks(
        requested, "readiness attestation"
    )
    if attestation.is_relative_to(target) or attestation.is_relative_to(candidate):
        _fail(
            "readiness attestation must remain outside source and candidate workspaces",
            attestation,
        )
    return attestation


def _validate_candidate_path(candidate: Path) -> None:
    if candidate.is_symlink() or not candidate.is_dir():
        _fail("candidate must be a real directory", candidate)


def _validate_manifest_path(manifest: Path | None) -> None:
    if manifest is not None and (manifest.is_symlink() or not manifest.is_file()):
        _fail("RESUME manifest must be a real file", manifest)


def _validate_runtime_metadata_namespace(
    target: Path,
    path: Path,
    label: str,
) -> None:
    parent_parts = target.parent.parts
    path_parts = path.parts
    if len(path_parts) <= len(parent_parts):
        return
    parent_key = tuple(filesystem_component_key(part) for part in parent_parts)
    path_parent_key = tuple(
        filesystem_component_key(part) for part in path_parts[: len(parent_parts)]
    )
    if path_parent_key != parent_key:
        return
    sibling_name = filesystem_component_key(path_parts[len(parent_parts)])
    exact_names = {
        filesystem_component_key(_journal_path(target).name),
        filesystem_component_key(_lock_path(target).name),
    }
    reserved_prefixes = (
        filesystem_component_key(_stage_prefix(target)),
        filesystem_component_key(_backup_prefix(target)),
        filesystem_component_key(_journal_temp_prefix(target)),
    )
    if sibling_name in exact_names or sibling_name.startswith(reserved_prefixes):
        _fail(
            f"{label} collides with target-owned publisher runtime metadata namespace",
            path,
        )


def _validate_static_input_relationships(
    target: Path,
    candidate: Path,
    manifest: Path | None,
    readiness_attestation: Path | None,
) -> None:
    if candidate == target or candidate.is_relative_to(target) or target.is_relative_to(candidate):
        _fail("candidate and target must be disjoint directories")
    _validate_runtime_metadata_namespace(target, candidate, "candidate")
    if manifest is not None:
        _validate_runtime_metadata_namespace(target, manifest, "RESUME manifest")
    if readiness_attestation is not None:
        _validate_runtime_metadata_namespace(
            target,
            readiness_attestation,
            "readiness attestation",
        )


def _validate_test_only_hook_configuration() -> None:
    checkpoint = os.environ.get(_TEST_ONLY_CRASH_ENV)
    force_rollback = os.environ.get(_TEST_ONLY_FORCE_ROLLBACK_ENV)
    source_mutation = os.environ.get(_TEST_ONLY_MUTATE_SOURCE_ENV)
    if checkpoint is None and force_rollback is None and source_mutation is None:
        return
    if os.environ.get(_TEST_ONLY_ACK_ENV) != _TEST_ONLY_ACK:
        _fail("test-only publisher hooks require the exact isolated-crash acknowledgement")
    if checkpoint is not None and checkpoint not in _TEST_ONLY_CHECKPOINTS:
        _fail(f"unknown test-only publisher crash checkpoint {checkpoint!r}")
    if force_rollback is not None and force_rollback != "1":
        _fail(f"{_TEST_ONLY_FORCE_ROLLBACK_ENV} accepts only the explicit value '1'")
    if source_mutation is not None and source_mutation not in _TEST_ONLY_SOURCE_MUTATIONS:
        _fail(f"unknown test-only source mutation {source_mutation!r}")


def _test_only_checkpoint(name: str) -> None:
    if os.environ.get(_TEST_ONLY_CRASH_ENV) != name:
        return
    # Configuration is validated before filesystem mutation.  SIGKILL is used
    # intentionally so normal exception/finally cleanup cannot run.
    os.kill(os.getpid(), signal.SIGKILL)
    os._exit(128 + signal.SIGKILL)


def _test_only_force_rollback() -> None:
    if os.environ.get(_TEST_ONLY_FORCE_ROLLBACK_ENV) == "1":
        _fail("test-only forced rollback requested")


def _test_only_mutate_source_before_backup_rename(target: Path) -> None:
    action = os.environ.get(_TEST_ONLY_MUTATE_SOURCE_ENV)
    if action is None:
        return

    fixture = target / _TEST_ONLY_MUTATION_DIRECTORY
    if fixture.is_symlink() or not fixture.is_dir():
        _fail("test-only source mutation fixture directory is missing", fixture)

    added = fixture / "added.txt"
    modified = fixture / "modified.txt"
    removed = fixture / "removed.txt"
    link_slot = fixture / "link-slot.txt"
    if action == "ADD":
        if _lexists(added):
            _fail("test-only ADD fixture path already exists", added)
        added.write_text("concurrent add\n", encoding="utf-8")
    elif action == "MODIFY":
        if modified.is_symlink() or not modified.is_file():
            _fail("test-only MODIFY fixture path is not a regular file", modified)
        modified.write_text("concurrent modification\n", encoding="utf-8")
    elif action == "REMOVE":
        if removed.is_symlink() or not removed.is_file():
            _fail("test-only REMOVE fixture path is not a regular file", removed)
        removed.unlink()
    elif action == "SYMLINK":
        if link_slot.is_symlink() or not link_slot.is_file():
            _fail("test-only SYMLINK fixture path is not a regular file", link_slot)
        link_slot.unlink()
        link_slot.symlink_to("modified.txt")
    else:
        feature = target / "feature_spec.md"
        if feature.is_symlink() or not feature.is_file():
            _fail("test-only INVALID_SCHEMA feature path is not a regular file", feature)
        feature.write_text(
            "temporarily invalid concurrent source bytes\n",
            encoding="utf-8",
        )


@contextmanager
def _workspace_lock(target: Path) -> Iterator[None]:
    path = _lock_path(target)
    if path.is_symlink():
        _fail("workspace publication lock must not be a symlink", path)
    existed = path.exists()
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NONBLOCK", 0)
    fd = _open_nofollow(path, flags, 0o600)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail("workspace publication lock must be a single-link regular file", path)
        if not existed:
            _fsync_directory(path.parent)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in {errno.EACCES, errno.EAGAIN}:
                _fail("another publisher already holds the workspace lock", path)
            raise
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _write_journal(target: Path, transaction: Transaction) -> None:
    journal = _journal_path(target)
    if journal.is_symlink():
        _fail("transaction journal must not be a symlink", journal)
    if journal.exists() and not journal.is_file():
        _fail("transaction journal must be a regular file", journal)

    data = (json.dumps(transaction.payload(), sort_keys=True, indent=2) + "\n").encode("utf-8")
    temp_path: Path | None = None
    fd: int | None = None
    try:
        for _ in range(16):
            candidate = target.parent / f"{_journal_temp_prefix(target)}{uuid.uuid4().hex}"
            try:
                fd = _open_nofollow(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                continue
            temp_path = candidate
            break
        if fd is None or temp_path is None:
            _fail("could not allocate a unique transaction journal temp file", target.parent)
        with os.fdopen(fd, "wb") as handle:
            fd = None
            handle.write(data)
            handle.flush()
            _fsync_fd(handle.fileno())
        os.replace(temp_path, journal)
        temp_path = None
        _fsync_directory(target.parent)
    finally:
        if fd is not None:
            os.close(fd)
        if temp_path is not None and _lexists(temp_path):
            if temp_path.is_symlink():
                _fail("journal temp path unexpectedly became a symlink", temp_path)
            temp_path.unlink()


def _reject_json_constant(value: str) -> object:
    raise ValueError(f"non-standard JSON constant {value!r}")


def _strict_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _read_journal_payload(path: Path) -> object:
    if not _lexists(path):
        return None
    if path.is_symlink():
        _fail("transaction journal must not be a symlink", path)
    fd = _open_nofollow(path, os.O_RDONLY)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail("transaction journal must be a single-link regular file", path)
        if metadata.st_size > _MAX_JOURNAL_BYTES:
            _fail("transaction journal exceeds the safe size limit", path)
        with os.fdopen(fd, "rb") as handle:
            fd = -1
            raw = handle.read(_MAX_JOURNAL_BYTES + 1)
    finally:
        if fd >= 0:
            os.close(fd)
    if len(raw) > _MAX_JOURNAL_BYTES:
        _fail("transaction journal exceeds the safe size limit", path)
    try:
        text = raw.decode("utf-8")
        return json.loads(
            text,
            parse_constant=_reject_json_constant,
            object_pairs_hook=_strict_json_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        _fail(f"transaction journal is malformed ({exc})", path)


def _parse_journal(target: Path, payload: object) -> Transaction:
    journal = _journal_path(target)
    if not isinstance(payload, dict):
        _fail("transaction journal root must be a JSON object", journal)
    if "version" not in payload:
        _fail("transaction journal keys are inconsistent (missing=['version'], extra=[])", journal)
    version = payload["version"]
    if type(version) is not int or version != JOURNAL_VERSION:
        _fail(f"unsupported transaction journal version {version!r}", journal)
    expected_keys = {
        "version",
        "mode",
        "target",
        "stage",
        "backup",
        "phase",
        "source_snapshot_sha256",
        "candidate_snapshot_sha256",
        "transaction_id",
    }
    expected_keys.add("observed_source_snapshot_sha256")
    if set(payload) != expected_keys:
        missing = sorted(expected_keys - set(payload))
        extra = sorted(set(payload) - expected_keys)
        _fail(f"transaction journal keys are inconsistent (missing={missing}, extra={extra})", journal)
    mode = payload["mode"]
    target_name = payload["target"]
    stage_name = payload["stage"]
    backup_name = payload["backup"]
    phase = payload["phase"]
    source_digest = payload["source_snapshot_sha256"]
    candidate_digest = payload["candidate_snapshot_sha256"]
    observed_source_digest = payload.get("observed_source_snapshot_sha256")
    transaction_id = payload["transaction_id"]
    string_fields = {
        "mode": mode,
        "target": target_name,
        "stage": stage_name,
        "phase": phase,
        "candidate_snapshot_sha256": candidate_digest,
        "transaction_id": transaction_id,
    }
    for field, value in string_fields.items():
        if not isinstance(value, str):
            _fail(f"transaction journal field {field!r} must be a string", journal)
    if mode not in MUTABLE_MODES:
        _fail(f"transaction journal contains unsupported mode {mode!r}", journal)
    if target_name != target.name:
        _fail("transaction journal target does not match the requested workspace", journal)
    if phase not in TRANSACTION_PHASES:
        _fail(f"transaction journal contains unknown phase {phase!r}", journal)
    if _TRANSACTION_ID_PATTERN.fullmatch(transaction_id) is None:
        _fail("transaction journal has an invalid transaction identity", journal)
    expected_stage = f"{_stage_prefix(target)}{transaction_id}"
    if stage_name != expected_stage:
        _fail("transaction journal stage is not the transaction-owned sibling path", journal)
    expected_backup = None if mode == "INIT" else f"{_backup_prefix(target)}{transaction_id}"
    if backup_name != expected_backup:
        _fail("transaction journal backup is not the transaction-owned sibling path", journal)
    if mode == "INIT":
        if source_digest is not None:
            _fail("INIT transaction journal must not contain a source snapshot", journal)
    elif not isinstance(source_digest, str) or _DIGEST_PATTERN.fullmatch(source_digest) is None:
        _fail("mutable transaction journal has an invalid source snapshot digest", journal)
    if not isinstance(candidate_digest, str) or _DIGEST_PATTERN.fullmatch(candidate_digest) is None:
        _fail("transaction journal has an invalid candidate snapshot digest", journal)
    if observed_source_digest is not None and (
        not isinstance(observed_source_digest, str)
        or _DIGEST_PATTERN.fullmatch(observed_source_digest) is None
    ):
        _fail("transaction journal has an invalid observed source snapshot digest", journal)
    if mode == "INIT" and observed_source_digest is not None:
        _fail("INIT transaction journal must not contain an observed source snapshot", journal)
    if observed_source_digest is not None and observed_source_digest == source_digest:
        _fail("observed source snapshot must identify a real source conflict", journal)
    if observed_source_digest is not None and phase != PHASE_ROLLBACK_REQUIRED:
        _fail("observed source snapshot is valid only while rollback is required", journal)

    return Transaction(
        mode=mode,
        target_name=target_name,
        stage_name=stage_name,
        backup_name=backup_name,
        phase=phase,
        source_snapshot_sha256=source_digest,
        candidate_snapshot_sha256=candidate_digest,
        observed_source_snapshot_sha256=observed_source_digest,
        transaction_id=transaction_id,
    )


def _read_journal(target: Path) -> Transaction | None:
    payload = _read_journal_payload(_journal_path(target))
    if payload is None:
        return None
    return _parse_journal(target, payload)


def _transaction_paths(target: Path, transaction: Transaction) -> tuple[Path, Path | None]:
    stage = target.parent / transaction.stage_name
    backup = target.parent / transaction.backup_name if transaction.backup_name is not None else None
    for label, path in (("stage", stage), ("backup", backup)):
        if path is None or not _lexists(path):
            continue
        if path.is_symlink():
            _fail(f"transaction {label} must not be a symlink", path)
        if not path.is_dir():
            _fail(f"transaction {label} must be a real directory", path)
    if _lexists(target):
        if target.is_symlink():
            _fail("transaction target must not be a symlink", target)
        if not target.is_dir():
            _fail("transaction target must be a real directory", target)
    return stage, backup


def _scan_residues(target: Path) -> list[Path]:
    prefixes = (_stage_prefix(target), _backup_prefix(target), _journal_temp_prefix(target))
    return sorted(
        (child for child in target.parent.iterdir() if child.name.startswith(prefixes)),
        key=lambda value: value.name,
    )


def _validate_residue_set(target: Path, transaction: Transaction | None) -> list[Path]:
    residues = _scan_residues(target)
    if transaction is None:
        if residues:
            names = [path.name for path in residues]
            _fail(
                f"orphan publisher residues require manual inspection; no journal authorizes recovery: {names}",
                target.parent,
            )
        return []

    allowed = {transaction.stage_name}
    if transaction.backup_name is not None:
        allowed.add(transaction.backup_name)
    journal_temps: list[Path] = []
    unexpected: list[str] = []
    for residue in residues:
        if residue.name in allowed:
            continue
        if residue.name.startswith(_journal_temp_prefix(target)):
            if residue.is_symlink() or not residue.is_file():
                _fail("transaction journal temp residue must be a real file", residue)
            journal_temps.append(residue)
        else:
            unexpected.append(residue.name)
    if unexpected:
        _fail(f"transaction journal does not own publisher residues {unexpected}", target.parent)
    return journal_temps


def _remove_journal(target: Path) -> None:
    journal = _journal_path(target)
    if not _lexists(journal):
        return
    if journal.is_symlink() or not journal.is_file():
        _fail("transaction journal changed type before cleanup", journal)
    journal.unlink()
    _fsync_directory(target.parent)


def _cleanup_journal_temps(paths: list[Path]) -> None:
    for path in paths:
        if not _lexists(path):
            continue
        if path.is_symlink() or not path.is_file():
            _fail("journal temp residue changed type before cleanup", path)
        path.unlink()
        _fsync_directory(path.parent)


def _advance(target: Path, transaction: Transaction, phase: str) -> Transaction:
    updated = replace(transaction, phase=phase)
    _write_journal(target, updated)
    return updated


def _validate_source_identity(path: Path, transaction: Transaction) -> None:
    if transaction.source_snapshot_sha256 is None:
        _fail("transaction has no source identity for rollback", path)
    validate_workspace(path)
    if _snapshot_digest(path) != transaction.source_snapshot_sha256:
        _fail("transaction source/backup no longer matches the journaled pre-state", path)


def _rollback_source_digest(transaction: Transaction) -> str:
    digest = transaction.observed_source_snapshot_sha256 or transaction.source_snapshot_sha256
    if digest is None:
        _fail("transaction has no rollback source identity")
    return digest


def _validate_rollback_source_digest(path: Path, transaction: Transaction) -> None:
    if _snapshot_digest(path) != _rollback_source_digest(transaction):
        _fail("transaction rollback source no longer matches its journaled identity", path)


def _restored_source_validation_error(path: Path) -> str | None:
    try:
        validate_workspace(path)
    except ValidationError as exc:
        return str(exc)
    return None


def _capture_unverified_backup_identity(
    target: Path,
    transaction: Transaction,
    stage: Path,
    backup: Path,
) -> tuple[Transaction, bool]:
    actual_digest = _snapshot_digest(backup)
    if transaction.observed_source_snapshot_sha256 is not None:
        if actual_digest != transaction.observed_source_snapshot_sha256:
            _fail("transaction rollback source no longer matches its journaled identity", backup)
        return transaction, True
    if actual_digest == transaction.source_snapshot_sha256:
        return transaction, False
    if transaction.phase not in {PHASE_PREPARED, PHASE_BACKUP_CREATED}:
        _fail("transaction source/backup no longer matches the journaled pre-state", backup)
    if target.exists() or not stage.exists():
        _fail("source conflict has an inconsistent target/stage layout", target.parent)
    return replace(transaction, observed_source_snapshot_sha256=actual_digest), True


def _validate_candidate_identity(path: Path, transaction: Transaction) -> None:
    validate_workspace(path)
    _require_candidate_snapshot(
        path,
        transaction.candidate_snapshot_sha256,
        transaction.mode,
        "published candidate no longer matches the journaled validated stage",
    )


def _rollback_init(target: Path, transaction: Transaction) -> None:
    stage, _ = _transaction_paths(target, transaction)
    transaction = _advance(target, transaction, PHASE_ROLLBACK_REQUIRED)
    if target.exists():
        if stage.exists():
            _fail("INIT rollback found both target and stage; refusing destructive cleanup", target)
        _durable_replace(target, stage)
    _test_only_checkpoint("DURING_ROLLBACK")
    _durable_remove(stage)
    _remove_journal(target)


def _finish_restored_update(
    target: Path,
    transaction: Transaction,
    stage: Path,
    *,
    source_conflict: bool,
    redundant_backup: Path | None = None,
) -> RollbackOutcome:
    # Digest identity is sufficient to prove that the exact captured bytes and
    # entry types are live again.  Schema validation intentionally happens only
    # after restoration so a temporarily invalid user edit is never stranded in
    # the hidden backup path.
    _validate_rollback_source_digest(target, transaction)
    validation_error = _restored_source_validation_error(target)
    if redundant_backup is not None:
        _durable_remove(redundant_backup)
    _durable_remove(stage)
    _remove_journal(target)
    return RollbackOutcome(
        source_conflict=source_conflict,
        restored_validation_error=validation_error,
    )


def _raise_rollback_outcome(target: Path, outcome: RollbackOutcome) -> None:
    if outcome.restored_validation_error is not None:
        prefix = (
            _SOURCE_CONFLICT_DIAGNOSTIC
            if outcome.source_conflict
            else "publication rollback completed"
        )
        _fail(
            f"{prefix}; {_RESTORED_SOURCE_INVALID_DIAGNOSTIC}: "
            f"{outcome.restored_validation_error}",
            target,
        )
    if outcome.source_conflict:
        _fail(_SOURCE_CONFLICT_DIAGNOSTIC, target)


def _rollback_update(target: Path, transaction: Transaction) -> RollbackOutcome:
    stage, backup = _transaction_paths(target, transaction)
    assert backup is not None
    conflict = transaction.observed_source_snapshot_sha256 is not None
    if backup.exists():
        transaction, conflict = _capture_unverified_backup_identity(
            target, transaction, stage, backup
        )
    transaction = _advance(target, transaction, PHASE_ROLLBACK_REQUIRED)

    if backup.exists():
        # Prove byte/type identity before changing any live target.  Full
        # workspace validation is deferred until the source is official again.
        _validate_rollback_source_digest(backup, transaction)
        if target.exists():
            target_digest = _snapshot_digest(target)
            if target_digest == _rollback_source_digest(transaction):
                _test_only_checkpoint("DURING_ROLLBACK")
                return _finish_restored_update(
                    target,
                    transaction,
                    stage,
                    source_conflict=conflict,
                    redundant_backup=backup,
                )
            if stage.exists():
                _fail("rollback found target, backup, and stage simultaneously", target.parent)
            _durable_replace(target, stage)
        _test_only_checkpoint("DURING_ROLLBACK")
        _durable_replace(backup, target)
        return _finish_restored_update(
            target,
            transaction,
            stage,
            source_conflict=conflict,
        )

    if not target.exists():
        _fail("rollback cannot restore the source because both target and backup are absent", target)
    _validate_rollback_source_digest(target, transaction)
    _test_only_checkpoint("DURING_ROLLBACK")
    return _finish_restored_update(
        target,
        transaction,
        stage,
        source_conflict=conflict,
    )


def _rollback_transaction(target: Path, transaction: Transaction) -> RollbackOutcome:
    if transaction.mode == "INIT":
        _rollback_init(target, transaction)
        return RollbackOutcome()
    return _rollback_update(target, transaction)


def _finish_init_recovery(target: Path, transaction: Transaction, stage: Path) -> None:
    if transaction.phase == PHASE_ROLLBACK_REQUIRED:
        _rollback_init(target, transaction)
        return
    if transaction.phase in {PHASE_BACKUP_CREATED, PHASE_BACKUP_VERIFIED}:
        _fail("INIT transaction cannot enter a backup phase", _journal_path(target))

    if transaction.phase == PHASE_PREPARED:
        if not target.exists() and stage.exists():
            _validate_candidate_identity(stage, transaction)
            _durable_replace(stage, target)
        elif target.exists() and not stage.exists():
            # Rename completed but the subsequent journal replace did not.
            pass
        else:
            _fail("prepared INIT journal has an inconsistent target/stage layout", target.parent)
        transaction = _advance(target, transaction, PHASE_CANDIDATE_PROMOTED)

    if transaction.phase == PHASE_CANDIDATE_PROMOTED:
        if not target.exists() or stage.exists():
            _fail("promoted INIT journal has an inconsistent target/stage layout", target.parent)
        _validate_candidate_identity(target, transaction)
        transaction = _advance(target, transaction, PHASE_CANDIDATE_VALIDATED)

    if transaction.phase == PHASE_CANDIDATE_VALIDATED:
        if not target.exists() or stage.exists():
            _fail("validated INIT journal has an inconsistent target/stage layout", target.parent)
        _validate_candidate_identity(target, transaction)
        transaction = _advance(target, transaction, PHASE_COMMITTED)

    if transaction.phase == PHASE_COMMITTED:
        if not target.exists():
            _fail("committed INIT journal has no live target", target)
        _validate_candidate_identity(target, transaction)
        _durable_remove(stage)
        _remove_journal(target)


def _finish_update_commit(
    target: Path,
    transaction: Transaction,
    stage: Path,
    backup: Path,
) -> None:
    if not target.exists():
        _fail("validated/committed transaction has no live target", target)
    _validate_candidate_identity(target, transaction)
    if transaction.phase != PHASE_COMMITTED:
        if not backup.exists():
            _fail("candidate was validated but its rollback backup is missing", backup)
        _validate_source_identity(backup, transaction)
        transaction = _advance(target, transaction, PHASE_COMMITTED)
    # Once committed is durable and the candidate identity is re-proven, any
    # transaction-owned backup/stage is a cleanup residue, not rollback input.
    _durable_remove(backup)
    _durable_remove(stage)
    _remove_journal(target)


def _recover_update_rollback(
    target: Path,
    transaction: Transaction,
) -> RollbackOutcome:
    return _rollback_update(target, transaction)


def _recover_update(
    target: Path,
    transaction: Transaction,
    stage: Path,
    backup: Path,
) -> RollbackOutcome:
    target_exists = target.exists()
    stage_exists = stage.exists()
    backup_exists = backup.exists()

    # A surviving backup has its journaled byte/type digest proven before any
    # recovery rename.  Schema validation happens on the restored official path.
    # If the target is absent, restoring the pre-state is the only safe outcome
    # regardless of how far a journal update had progressed.
    if not target_exists and backup_exists:
        return _recover_update_rollback(target, transaction)

    if transaction.phase == PHASE_PREPARED:
        if target_exists and stage_exists and not backup_exists:
            _validate_source_identity(target, transaction)
            _validate_candidate_identity(stage, transaction)
            _durable_remove(stage)
            _remove_journal(target)
            return RollbackOutcome()
        if target_exists and backup_exists:
            return _recover_update_rollback(target, transaction)
        _fail("prepared transaction journal has no recoverable source/stage layout", target.parent)

    if transaction.phase in {
        PHASE_BACKUP_CREATED,
        PHASE_BACKUP_VERIFIED,
        PHASE_CANDIDATE_PROMOTED,
        PHASE_ROLLBACK_REQUIRED,
    }:
        if backup_exists:
            return _recover_update_rollback(target, transaction)
        if transaction.phase == PHASE_ROLLBACK_REQUIRED and target_exists:
            return _recover_update_rollback(target, transaction)
        _fail(f"{transaction.phase} transaction is missing its rollback backup", backup)

    if transaction.phase == PHASE_CANDIDATE_VALIDATED:
        if target_exists and backup_exists:
            _finish_update_commit(target, transaction, stage, backup)
            return RollbackOutcome()
        _fail("candidate_validated transaction has an inconsistent target/backup layout", target.parent)

    if transaction.phase == PHASE_COMMITTED:
        if target_exists:
            _finish_update_commit(target, transaction, stage, backup)
            return RollbackOutcome()
        _fail("committed transaction has no target or recoverable backup", target.parent)

    _fail(f"unhandled transaction recovery phase {transaction.phase!r}", _journal_path(target))


def _recover_locked(target: Path) -> bool:
    transaction = _read_journal(target)
    journal_temps = _validate_residue_set(target, transaction)
    if transaction is None:
        return False

    stage, backup = _transaction_paths(target, transaction)
    outcome = RollbackOutcome()
    if transaction.mode == "INIT":
        _finish_init_recovery(target, transaction, stage)
    else:
        assert backup is not None
        outcome = _recover_update(target, transaction, stage, backup)
    _cleanup_journal_temps(journal_temps)
    _raise_rollback_outcome(target, outcome)
    return True


def recover_incomplete_publication(target: str | Path) -> bool:
    """Recover one journaled workspace transaction; return whether one existed."""

    target_path = _normalize_target(target)
    _validate_test_only_hook_configuration()
    with _workspace_lock(target_path):
        return _recover_locked(target_path)


def _validate_candidate(
    mode: str,
    target: Path,
    candidate: Path,
    manifest_path: Path | None,
    readiness_attestation: Path | None,
) -> None:
    if mode == "INIT":
        validate_init_transition(target, candidate)
    elif mode == "RESUME":
        assert manifest_path is not None
        validate_resume_transition(target, candidate, manifest_path)
    else:
        assert readiness_attestation is not None
        validate_readiness_attestation(
            target,
            readiness_attestation,
            candidate=candidate,
        )
        _reject_close_candidate_metadata(candidate)
        validate_close_transition(target, candidate)
        expected_feature = render_closed_feature(target)
        candidate_feature = candidate / "feature_spec.md"
        if candidate_feature.read_bytes() != expected_feature:
            _fail(
                "CLOSE candidate is not the exact deterministic rendering of the attested source",
                candidate_feature,
            )


def _allocate_transaction_paths(target: Path, mode: str) -> tuple[str, Path, Path | None]:
    for _ in range(16):
        transaction_id = uuid.uuid4().hex
        stage = target.parent / f"{_stage_prefix(target)}{transaction_id}"
        backup = None if mode == "INIT" else target.parent / f"{_backup_prefix(target)}{transaction_id}"
        if _lexists(stage) or (backup is not None and _lexists(backup)):
            continue
        stage.mkdir(mode=0o700)
        _fsync_directory(target.parent)
        return transaction_id, stage, backup
    _fail("could not allocate transaction-owned stage and backup paths", target.parent)


def publish_candidate(
    mode: str,
    target: str | Path,
    candidate: str | Path,
    *,
    manifest_path: str | Path | None = None,
    readiness_attestation: str | Path | None = None,
    before_publish: Callable[[], None] | None = None,
) -> Path:
    """Publish a validated candidate with rollback and next-run recovery."""

    if mode not in MUTABLE_MODES:
        raise ValidationError("publisher accepts only explicit INIT, RESUME, or CLOSE")
    target_path = _normalize_target(target)
    candidate_path = _preflight_candidate_path(candidate)
    manifest = _preflight_manifest_path(
        mode,
        manifest_path,
        target_path,
        candidate_path,
    )
    attestation = _preflight_readiness_attestation_path(
        mode,
        readiness_attestation,
        target_path,
        candidate_path,
    )
    _validate_static_input_relationships(
        target_path,
        candidate_path,
        manifest,
        attestation,
    )
    _validate_test_only_hook_configuration()

    # A normal CLOSE with an invalid receipt fails without creating persistent
    # runtime metadata.  An existing journal remains higher authority: its
    # recovery must run under the workspace lock before fresh-input validation.
    if (
        mode == "CLOSE"
        and attestation is not None
        and not _lexists(_journal_path(target_path))
    ):
        validate_readiness_attestation(
            target_path,
            attestation,
            candidate=candidate_path,
        )

    with _workspace_lock(target_path):
        # Lexical/component boundaries are preflighted before lock creation, but
        # recovery remains ahead of candidate/manifest existence and content
        # validation so incomplete transactions never depend on fresh inputs.
        _recover_locked(target_path)
        _validate_candidate_path(candidate_path)
        _validate_manifest_path(manifest)
        if mode == "INIT":
            if _lexists(target_path):
                _fail("INIT destination already exists", target_path)
        elif target_path.is_symlink() or not target_path.is_dir():
            _fail(f"{mode} target must be an existing workspace directory", target_path)

        transaction_id, stage, backup = _allocate_transaction_paths(target_path, mode)
        journal_persisted = False
        committed = False
        transaction: Transaction | None = None
        try:
            _copy_candidate_tree(candidate_path, stage)
            candidate_digest = _snapshot_digest(stage)
            source_digest = _snapshot_digest(target_path) if mode != "INIT" else None
            _validate_candidate(
                mode,
                target_path,
                stage,
                manifest,
                attestation,
            )
            _require_candidate_snapshot(
                stage,
                candidate_digest,
                mode,
                f"{mode} candidate changed during validation",
            )
            if source_digest is not None and _snapshot_digest(target_path) != source_digest:
                _fail(f"{mode} source changed during candidate validation", target_path)
            _fsync_tree(stage)
            _require_candidate_snapshot(
                stage,
                candidate_digest,
                mode,
                f"{mode} candidate changed while synchronizing",
            )
            if source_digest is not None and _snapshot_digest(target_path) != source_digest:
                _fail(f"{mode} source changed while synchronizing candidate", target_path)

            if before_publish is not None:
                before_publish()
            _require_candidate_snapshot(
                stage,
                candidate_digest,
                mode,
                f"{mode} candidate changed after validation",
            )
            if mode == "INIT":
                if _lexists(target_path):
                    _fail("INIT destination appeared before publication", target_path)
            else:
                assert source_digest is not None
                if target_path.is_symlink() or not target_path.is_dir():
                    _fail(f"{mode} source disappeared after candidate validation", target_path)
                if _snapshot_digest(target_path) != source_digest:
                    _fail(f"{mode} source changed after candidate validation", target_path)

            transaction = Transaction(
                mode=mode,
                target_name=target_path.name,
                stage_name=stage.name,
                backup_name=backup.name if backup is not None else None,
                phase=PHASE_PREPARED,
                source_snapshot_sha256=source_digest,
                candidate_snapshot_sha256=candidate_digest,
                observed_source_snapshot_sha256=None,
                transaction_id=transaction_id,
            )
            _write_journal(target_path, transaction)
            journal_persisted = True
            _test_only_checkpoint("JOURNAL_PREPARED")

            if mode == "INIT":
                if _lexists(target_path):
                    _fail("INIT destination appeared before the publication rename", target_path)
            else:
                assert backup is not None and source_digest is not None
                if _snapshot_digest(target_path) != source_digest:
                    _fail(f"{mode} source changed before the backup rename", target_path)
                _test_only_mutate_source_before_backup_rename(target_path)
                _durable_replace(target_path, backup)
                _test_only_checkpoint("TARGET_TO_BACKUP_RENAMED")
                transaction = _advance(target_path, transaction, PHASE_BACKUP_CREATED)

                backup_digest = _snapshot_digest(backup)
                if backup_digest != source_digest:
                    transaction = replace(
                        transaction,
                        observed_source_snapshot_sha256=backup_digest,
                    )
                    transaction = _advance(
                        target_path, transaction, PHASE_ROLLBACK_REQUIRED
                    )
                    _fail(_SOURCE_CONFLICT_DIAGNOSTIC, backup)
                validate_workspace(backup)
                transaction = _advance(
                    target_path, transaction, PHASE_BACKUP_VERIFIED
                )

            _require_candidate_snapshot(
                stage,
                candidate_digest,
                mode,
                f"{mode} candidate changed before the publication rename",
            )
            _durable_replace(stage, target_path)
            _test_only_checkpoint("STAGE_TO_TARGET_RENAMED")
            transaction = _advance(target_path, transaction, PHASE_CANDIDATE_PROMOTED)
            _test_only_checkpoint("BEFORE_TARGET_VALIDATION")
            _test_only_force_rollback()

            # The transition was fully validated before swapping.  Post-swap we
            # prove the official path is structurally valid and byte-identical
            # (by complete workspace snapshot) to that validated stage.
            _validate_candidate_identity(target_path, transaction)
            transaction = _advance(target_path, transaction, PHASE_CANDIDATE_VALIDATED)
            _test_only_checkpoint("AFTER_TARGET_VALIDATION")

            transaction = _advance(target_path, transaction, PHASE_COMMITTED)
            committed = True
            _test_only_checkpoint("BEFORE_BACKUP_REMOVAL")
            if backup is not None:
                _durable_remove(backup)
            _remove_journal(target_path)
            return target_path
        except BaseException as publication_error:
            if journal_persisted and not committed and transaction is not None:
                try:
                    outcome = _rollback_transaction(target_path, transaction)
                    journal_persisted = False
                except BaseException as rollback_error:
                    raise ValidationError(
                        "publication failed and safe rollback is incomplete; "
                        f"journal retained for recovery: {rollback_error}"
                    ) from rollback_error
                if outcome.restored_validation_error is not None:
                    try:
                        _raise_rollback_outcome(target_path, outcome)
                    except ValidationError as restored_error:
                        raise restored_error from publication_error
            raise
        finally:
            # Never destroy evidence owned by an unresolved journal.  A later
            # invocation will recover it under the workspace lock.
            if not journal_persisted and _lexists(stage):
                _durable_remove(stage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=sorted(MUTABLE_MODES))
    parser.add_argument("target", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--readiness-attestation", type=Path)
    args = parser.parse_args()
    try:
        published = publish_candidate(
            args.mode,
            args.target,
            args.candidate,
            manifest_path=args.manifest,
            readiness_attestation=args.readiness_attestation,
        )
    except (OSError, ValidationError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"PASS: {args.mode} published validated candidate at {published}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
