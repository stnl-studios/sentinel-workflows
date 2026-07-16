#!/usr/bin/env python3
"""Validate and atomically publish a staged mutable SPEC lifecycle candidate."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Callable

from validate_spec_lifecycle import (
    ValidationError,
    validate_close_transition,
    validate_init_transition,
    validate_resume_transition,
    validate_workspace,
    workspace_snapshot,
)


MUTABLE_MODES = {"INIT", "RESUME", "CLOSE"}


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def _validate_candidate(mode: str, target: Path, candidate: Path) -> None:
    if mode == "INIT":
        validate_init_transition(target, candidate)
    elif mode == "RESUME":
        validate_resume_transition(target, candidate)
    else:
        validate_close_transition(target, candidate)


def publish_candidate(
    mode: str,
    target: str | Path,
    candidate: str | Path,
    *,
    before_publish: Callable[[], None] | None = None,
) -> Path:
    """Publish a prebuilt candidate while preserving the prior state on failure."""

    normalized_mode = mode.upper()
    if normalized_mode not in MUTABLE_MODES:
        raise ValidationError("publisher accepts only explicit INIT, RESUME, or CLOSE")

    requested_target = Path(target).expanduser()
    requested_candidate = Path(candidate).expanduser()
    if requested_target.is_symlink():
        raise ValidationError(f"target must not be a symlink: {requested_target}")
    if requested_candidate.is_symlink():
        raise ValidationError(f"candidate must not be a symlink: {requested_candidate}")
    target_path = requested_target.resolve()
    candidate_path = requested_candidate.resolve()
    if not candidate_path.is_dir():
        raise ValidationError(f"candidate must be a real directory: {candidate_path}")
    if not target_path.parent.is_dir():
        raise ValidationError(f"target parent must already exist: {target_path.parent}")
    if candidate_path == target_path or candidate_path.is_relative_to(target_path) or target_path.is_relative_to(candidate_path):
        raise ValidationError("candidate and target must be disjoint directories")
    if normalized_mode == "INIT":
        if target_path.exists() or target_path.is_symlink():
            raise ValidationError(f"INIT destination already exists: {target_path}")
    elif not target_path.is_dir():
        raise ValidationError(f"{normalized_mode} target must be an existing workspace directory: {target_path}")

    stage = Path(tempfile.mkdtemp(prefix=f".{target_path.name}.lifecycle-stage-", dir=target_path.parent))
    backup: Path | None = None
    published = False
    try:
        stage.rmdir()
        shutil.copytree(candidate_path, stage, symlinks=True)
        _validate_candidate(normalized_mode, target_path, stage)
        staged_snapshot = workspace_snapshot(stage)
        source_snapshot = workspace_snapshot(target_path) if normalized_mode != "INIT" else None
        if before_publish is not None:
            before_publish()

        if normalized_mode == "INIT":
            if target_path.exists() or target_path.is_symlink():
                raise ValidationError(f"INIT destination appeared before publication: {target_path}")
            os.replace(stage, target_path)
        else:
            if workspace_snapshot(target_path) != source_snapshot:
                raise ValidationError(f"{normalized_mode} source changed after candidate validation")
            backup = Path(tempfile.mkdtemp(prefix=f".{target_path.name}.lifecycle-backup-", dir=target_path.parent))
            backup.rmdir()
            os.replace(target_path, backup)
            try:
                os.replace(stage, target_path)
            except BaseException:
                os.replace(backup, target_path)
                backup = None
                raise
        published = True

        if normalized_mode == "INIT":
            validate_workspace(target_path)
            if workspace_snapshot(target_path) != staged_snapshot:
                raise ValidationError("published INIT state differs from the validated candidate")
        elif normalized_mode == "RESUME":
            assert backup is not None
            validate_resume_transition(backup, target_path)
        else:
            assert backup is not None
            validate_close_transition(backup, target_path)

        if backup is not None:
            shutil.rmtree(backup)
            backup = None
        return target_path
    except BaseException:
        if published:
            _remove_path(target_path)
            if backup is not None and backup.exists():
                os.replace(backup, target_path)
                backup = None
        raise
    finally:
        _remove_path(stage)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=sorted(MUTABLE_MODES))
    parser.add_argument("target", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    try:
        published = publish_candidate(args.mode, args.target, args.candidate)
    except (OSError, ValidationError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"PASS: {args.mode} published validated candidate at {published}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
