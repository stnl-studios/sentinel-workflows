#!/usr/bin/env python3
"""Create and validate a strict readiness attestation for one SPEC snapshot."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import NoReturn

from validate_spec_lifecycle import (
    ValidationError,
    Workspace,
    canonical_path_without_symlinks,
    validate_workspace,
)


READINESS_ATTESTATION_VERSION = 1
READINESS_ATTESTATION_FIELDS = {
    "version",
    "mode",
    "scope",
    "verdict",
    "workspace_identity",
    "workspace_snapshot_sha256",
}
WORKSPACE_IDENTITY_FIELDS = {"h1", "path_sha256"}
SHA256_RE = re.compile(r"[0-9a-f]{64}")
MAX_ATTESTATION_BYTES = 64 * 1024
SNAPSHOT_DOMAIN = b"stnl-readiness-authority-snapshot-v1\0"
IDENTITY_DOMAIN = b"stnl-readiness-workspace-path-v1\0"


def _fail(message: str) -> NoReturn:
    raise ValidationError(message)


def _has_traversal(path: Path) -> bool:
    return any(part == ".." for part in path.parts)


def _is_within(path: Path, root: Path) -> bool:
    return path == root or path.is_relative_to(root)


def _requested_path(value: str | Path, label: str) -> Path:
    requested = Path(value).expanduser()
    if _has_traversal(requested):
        _fail(f"{label} must not contain path traversal")
    return requested


def _authority_paths(workspace: Workspace) -> tuple[tuple[str, Path], ...]:
    relative_paths = ("feature_spec.md", *sorted(workspace.artifacts.values()))
    result: list[tuple[str, Path]] = []
    for relative in relative_paths:
        relative_path = Path(relative)
        if relative_path.is_absolute() or _has_traversal(relative_path):
            _fail(f"invalid lifecycle authority path: {relative!r}")
        path = workspace.root / relative_path
        if path.is_symlink() or not path.is_file():
            _fail(f"lifecycle authority must be a real file: {path}")
        result.append((relative_path.as_posix(), path))
    return tuple(result)


def _read_authority_bytes(path: Path) -> bytes:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            _fail(f"lifecycle authority must not be a symlink: {path}")
        raise
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail(f"lifecycle authority must be a single-link regular file: {path}")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            return stream.read()
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def workspace_authority_snapshot_sha256(workspace: Workspace) -> str:
    """Hash only feature_spec.md and the indexed, materialized shared authority."""

    digest = hashlib.sha256(SNAPSHOT_DOMAIN)
    for relative, path in _authority_paths(workspace):
        encoded_path = relative.encode("utf-8")
        data = _read_authority_bytes(path)
        digest.update(len(encoded_path).to_bytes(8, "big"))
        digest.update(encoded_path)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def _workspace_identity(workspace: Workspace) -> dict[str, str]:
    canonical_path = workspace.root.as_posix().encode("utf-8")
    return {
        "h1": workspace.h1,
        "path_sha256": hashlib.sha256(IDENTITY_DOMAIN + canonical_path).hexdigest(),
    }


def _require_ready_workspace(source: str | Path) -> Workspace:
    requested_source = _requested_path(source, "source")
    workspace = validate_workspace(requested_source)
    if workspace.closed or workspace.status != "ready":
        _fail("readiness attestation requires an active ready workspace")
    return workspace


def _attestation_payload(workspace: Workspace, *, scope: str, verdict: str) -> dict[str, object]:
    if scope != "GLOBAL":
        _fail("readiness attestation requires scope GLOBAL")
    if verdict != "READY":
        _fail("readiness attestation requires verdict READY")
    return {
        "version": READINESS_ATTESTATION_VERSION,
        "mode": "READINESS",
        "scope": scope,
        "verdict": verdict,
        "workspace_identity": _workspace_identity(workspace),
        "workspace_snapshot_sha256": workspace_authority_snapshot_sha256(workspace),
    }


def _encode_attestation(payload: dict[str, object]) -> bytes:
    return (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode("utf-8")


def _attestation_output_path(attestation: str | Path, workspace: Workspace) -> Path:
    requested = _requested_path(attestation, "attestation output")
    output = canonical_path_without_symlinks(requested, "attestation output")
    if output.exists() or output.is_symlink():
        _fail(f"attestation output must not exist or be a symlink: {output}")
    parent = output.parent
    if not parent.is_dir():
        _fail(f"attestation output parent must be a real directory: {parent}")
    if _is_within(output, workspace.root):
        _fail("attestation output must be outside the workspace")
    return output


def create_readiness_attestation(
    source: str | Path,
    attestation: str | Path,
    *,
    scope: str,
    verdict: str,
) -> Path:
    """Write a deterministic GLOBAL/READY attestation without mutating the workspace."""

    workspace = _require_ready_workspace(source)
    output = _attestation_output_path(attestation, workspace)
    encoded = _encode_attestation(_attestation_payload(workspace, scope=scope, verdict=verdict))
    created = False
    try:
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        if created and output.exists() and not output.is_symlink():
            output.unlink()
        raise
    return output


def _reject_duplicate_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            _fail(f"readiness attestation contains duplicate JSON field {key!r}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> NoReturn:
    _fail(f"readiness attestation contains invalid JSON constant {value!r}")


def _exact_object(value: object, fields: set[str], label: str) -> dict[str, object]:
    if type(value) is not dict:
        _fail(f"readiness attestation {label} must be a JSON object")
    mapping = value
    actual = set(mapping)
    if actual != fields:
        _fail(
            f"readiness attestation {label} fields are invalid; "
            f"unknown={sorted(actual - fields)}, missing={sorted(fields - actual)}"
        )
    return mapping


def _nonempty_string(value: object, label: str) -> str:
    if type(value) is not str or not value:
        _fail(f"readiness attestation {label} must be a non-empty string")
    return value


def _sha256(value: object, label: str) -> str:
    digest = _nonempty_string(value, label)
    if SHA256_RE.fullmatch(digest) is None:
        _fail(f"readiness attestation {label} must be a lowercase SHA-256 digest")
    return digest


def _read_attestation_bytes(path: Path) -> bytes:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            _fail("readiness attestation must not be a symlink")
        if exc.errno in {errno.ENOENT, errno.ENOTDIR}:
            _fail(f"readiness attestation must be a real file: {path}")
        raise
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            _fail("readiness attestation must be a single-link regular file")
        if metadata.st_size > MAX_ATTESTATION_BYTES:
            _fail("readiness attestation exceeds the safe size limit")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            raw = stream.read(MAX_ATTESTATION_BYTES + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(raw) > MAX_ATTESTATION_BYTES:
        _fail("readiness attestation exceeds the safe size limit")
    return raw


def _load_attestation(path: Path) -> dict[str, object]:
    try:
        raw = _read_attestation_bytes(path)
        payload = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_fields,
            parse_constant=_reject_json_constant,
        )
    except ValidationError:
        raise
    except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        _fail(f"readiness attestation is malformed: {exc}")
    return _exact_object(payload, READINESS_ATTESTATION_FIELDS, "root")


def _parse_attestation(path: Path) -> dict[str, object]:
    payload = _load_attestation(path)
    version = payload["version"]
    if type(version) is not int or version != READINESS_ATTESTATION_VERSION:
        _fail(f"readiness attestation has unsupported version {version!r}")
    for field, expected in (
        ("mode", "READINESS"),
        ("scope", "GLOBAL"),
        ("verdict", "READY"),
    ):
        actual = _nonempty_string(payload[field], field)
        if actual != expected:
            _fail(f"readiness attestation requires {field} {expected}; got {actual!r}")
    identity = _exact_object(
        payload["workspace_identity"], WORKSPACE_IDENTITY_FIELDS, "workspace_identity"
    )
    _nonempty_string(identity["h1"], "workspace_identity.h1")
    _sha256(identity["path_sha256"], "workspace_identity.path_sha256")
    _sha256(payload["workspace_snapshot_sha256"], "workspace_snapshot_sha256")
    return payload


def validate_readiness_attestation(
    source: str | Path,
    attestation: str | Path,
    *,
    candidate: str | Path | None = None,
) -> tuple[Workspace, str]:
    """Validate schema, identity and current authority digest for CLOSE."""

    workspace = _require_ready_workspace(source)
    requested_attestation = _requested_path(attestation, "readiness attestation")
    attestation_path = canonical_path_without_symlinks(
        requested_attestation, "readiness attestation"
    )
    if _is_within(attestation_path, workspace.root):
        _fail("readiness attestation must be outside the workspace")
    if candidate is not None:
        requested_candidate = _requested_path(candidate, "candidate")
        candidate_path = canonical_path_without_symlinks(requested_candidate, "candidate")
        if _is_within(attestation_path, candidate_path):
            _fail("readiness attestation must be outside the candidate")

    payload = _parse_attestation(attestation_path)
    expected_identity = _workspace_identity(workspace)
    if payload["workspace_identity"] != expected_identity:
        _fail("readiness attestation workspace identity does not match the CLOSE source")
    expected_snapshot = payload["workspace_snapshot_sha256"]
    actual_snapshot = workspace_authority_snapshot_sha256(workspace)
    if actual_snapshot != expected_snapshot:
        _fail("readiness attestation is stale; rerun READINESS GLOBAL")
    return workspace, actual_snapshot


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("attestation", type=Path)
    parser.add_argument("--scope", required=True)
    parser.add_argument("--verdict", required=True)
    args = parser.parse_args()
    try:
        output = create_readiness_attestation(
            args.source,
            args.attestation,
            scope=args.scope,
            verdict=args.verdict,
        )
    except (OSError, UnicodeError, ValidationError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"PASS: readiness attestation created at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
