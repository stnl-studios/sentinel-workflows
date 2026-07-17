#!/usr/bin/env python3
"""Build a deterministic, lossless CLOSE candidate without model generation."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from create_readiness_attestation import (
    validate_readiness_attestation,
    workspace_authority_snapshot_sha256,
)
from validate_spec_lifecycle import (
    ACTIVE_SECTIONS,
    ValidationError,
    canonical_path_without_symlinks,
    validate_close_transition,
    validate_workspace,
)


IGNORED_METADATA = {".DS_Store", "__MACOSX"}
CLOSED_HEADER = b"""# File Purpose Header

```yaml
purpose: Template for the final lossless documentary feature SPEC.
status: closed
read_when: Maintaining, validating, extending, or revisiting the closed feature requirements.
do_not_read_when: Looking for session history, implementation evidence, or delivery records.
contains: Durable objective, context, scope, rules, exact canonical items, contracts, and all final questions.
owner: stnl-spec-lifecycle-manager
update_policy: Update only through an explicit future documentary lifecycle action.
```
"""
CLOSED_CATEGORIES = (
    ("requirements", "Requirements"),
    ("acceptance_criteria", "Final Acceptance Criteria"),
    ("decisions", "Durable Decisions"),
    ("constraints", "Relevant Constraints"),
    ("risks", "Relevant Risks"),
)


@dataclass
class ExternalLinkGroup:
    first_stage_path: Path
    source_link_count: int
    seen: int
    kind: str


def _ignored(path: Path) -> bool:
    return any(part in IGNORED_METADATA or part.startswith("._") for part in path.parts)


def _has_path_traversal(path: Path) -> bool:
    return any(part == ".." for part in path.parts)


def _lexists(path: Path) -> bool:
    return os.path.lexists(path)


def _directory_identity(path: Path, label: str) -> tuple[int, int]:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise ValidationError(f"{label} disappeared: {path}") from exc
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise ValidationError(f"{label} must remain a real directory: {path}")
    return metadata.st_dev, metadata.st_ino


def _require_directory_identity(
    path: Path,
    expected: tuple[int, int],
    label: str,
) -> None:
    if _directory_identity(path, label) != expected:
        raise ValidationError(f"{label} ownership/inode changed: {path}")


def _remove_owned_directory(path: Path, expected: tuple[int, int], label: str) -> None:
    _require_directory_identity(path, expected, label)
    shutil.rmtree(path)


def _rollback_promoted_candidate(
    candidate: Path,
    stage: Path,
    expected: tuple[int, int],
) -> None:
    if _lexists(stage):
        raise ValidationError(f"CLOSE rollback stage path unexpectedly exists: {stage}")
    _require_directory_identity(candidate, expected, "promoted CLOSE candidate")
    os.replace(candidate, stage)
    _require_directory_identity(stage, expected, "rolled-back CLOSE stage")


def _copy_external(
    source: Path,
    destination: Path,
    relative: Path,
    link_groups: dict[tuple[int, int], ExternalLinkGroup],
) -> None:
    """Copy one external tree without following links or accepting special files."""

    if _ignored(relative):
        return
    metadata = source.lstat()
    mode = metadata.st_mode
    if stat.S_ISLNK(mode) or stat.S_ISREG(mode):
        destination.parent.mkdir(parents=True, exist_ok=True)
        link_key = (metadata.st_dev, metadata.st_ino)
        kind = "symlink" if stat.S_ISLNK(mode) else "file"
        group = link_groups.get(link_key) if metadata.st_nlink > 1 else None
        if group is not None:
            if group.source_link_count != metadata.st_nlink or group.kind != kind:
                raise ValidationError(
                    f"external hardlink group changed while rendering: {source}"
                )
            os.link(group.first_stage_path, destination, follow_symlinks=False)
            group.seen += 1
            return
    if stat.S_ISLNK(mode):
        os.symlink(os.readlink(source), destination)
        if metadata.st_nlink > 1:
            link_groups[link_key] = ExternalLinkGroup(
                destination,
                metadata.st_nlink,
                1,
                kind,
            )
        return
    if stat.S_ISREG(mode):
        shutil.copy2(source, destination, follow_symlinks=False)
        if metadata.st_nlink > 1:
            link_groups[link_key] = ExternalLinkGroup(
                destination,
                metadata.st_nlink,
                1,
                kind,
            )
        return
    if stat.S_ISDIR(mode):
        destination.mkdir()
        for child in sorted(source.iterdir(), key=lambda path: path.name):
            _copy_external(
                child,
                destination / child.name,
                relative / child.name,
                link_groups,
            )
        shutil.copystat(source, destination, follow_symlinks=False)
        return
    raise ValidationError(f"unsupported external filesystem entry: {source}")


def _validate_external_link_groups(
    link_groups: dict[tuple[int, int], ExternalLinkGroup],
) -> None:
    for group in link_groups.values():
        if group.seen != group.source_link_count:
            raise ValidationError(
                "external hardlink group crosses the CLOSE preservation boundary"
            )
        metadata = group.first_stage_path.lstat()
        if metadata.st_nlink != group.source_link_count:
            raise ValidationError(
                "rendered external hardlink topology changed before validation"
            )


def _active_parts(data: bytes) -> tuple[bytes, dict[str, bytes]]:
    matches = list(re.finditer(rb"(?m)^## (?P<name>[^\n]+)\n", data))
    names = [match.group("name").decode("utf-8") for match in matches]
    if names != ACTIVE_SECTIONS:
        raise ValidationError("active feature sections changed after structural validation")
    parts: dict[str, bytes] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(data)
        parts[names[index]] = data[match.start() : end]
    return data[: matches[0].start()], parts


def _close_header(prefix: bytes) -> bytes:
    fence_end = prefix.find(b"```\n")
    if fence_end < 0:
        raise ValidationError("cannot locate the validated File Purpose Header")
    header_end = fence_end + 4
    header = prefix[:header_end]
    if header.count(b"\nstatus: ready\n") != 1:
        raise ValidationError("CLOSE source header must contain exactly one ready status")
    return CLOSED_HEADER + prefix[header_end:]


def _rename_h2(block: bytes, source: str, destination: str) -> bytes:
    old = f"## {source}\n".encode("utf-8")
    if not block.startswith(old):
        raise ValidationError(f"cannot locate validated section {source!r}")
    return f"## {destination}\n".encode("utf-8") + block[len(old) :]


def _record_region(path: Path) -> bytes:
    data = path.read_bytes()
    match = re.search(rb"(?m)^### (?:AC|RK|R|D|C|Q)-\d{3} \xe2\x80\x94 ", data)
    if match is None:
        raise ValidationError(f"validated canonical records disappeared from {path}")
    return data[match.start() :]


def _append_block(output: bytearray, block: bytes) -> None:
    if output and not output.endswith(b"\n\n"):
        output.extend(b"\n" if output.endswith(b"\n") else b"\n\n")
    output.extend(block)


def render_closed_feature(source: Path) -> bytes:
    """Return the sole deterministic closed feature rendering for one ready source."""

    workspace = validate_workspace(source)
    if workspace.closed or workspace.status != "ready":
        raise ValidationError("CLOSE renderer requires an active ready workspace")

    prefix, active = _active_parts((source / "feature_spec.md").read_bytes())
    output = bytearray(_close_header(prefix))
    _append_block(output, active["Objective"])
    _append_block(output, active["Context"])
    _append_block(output, _rename_h2(active["Scope"], "Scope", "Final Scope"))
    _append_block(output, active["Out of Scope"])

    requirements = workspace.artifacts.get("requirements")
    if requirements is None:
        raise ValidationError("active ready workspace has no canonical requirements")
    _append_block(output, b"## Requirements\n\n" + _record_region(source / requirements))

    _append_block(output, active["Business Rules"])
    for key, heading in CLOSED_CATEGORIES[1:]:
        artifact = workspace.artifacts.get(key)
        if artifact is not None:
            _append_block(output, f"## {heading}\n\n".encode("utf-8") + _record_region(source / artifact))

    _append_block(
        output,
        _rename_h2(active["Relevant Contracts"], "Relevant Contracts", "Important Contracts"),
    )
    questions = workspace.artifacts.get("questions")
    if questions is not None:
        _append_block(
            output,
            b"## Durable Resolved Questions\n\n" + _record_region(source / questions),
        )
    if not output.endswith(b"\n"):
        output.extend(b"\n")
    return bytes(output)


def _require_attested_snapshot(source: Path, expected_snapshot: str) -> None:
    current = validate_workspace(source)
    if workspace_authority_snapshot_sha256(current) != expected_snapshot:
        raise ValidationError(
            "readiness attestation became stale during CLOSE; "
            "rerun READINESS GLOBAL"
        )


def build_closed_candidate(
    source: str | Path,
    candidate: str | Path,
    *,
    readiness_attestation: str | Path,
) -> Path:
    """Render and validate a complete candidate while leaving the source untouched."""

    requested_source = Path(source).expanduser()
    requested_candidate = Path(candidate).expanduser()
    if _has_path_traversal(requested_source) or _has_path_traversal(requested_candidate):
        raise ValidationError("source and candidate must not contain path traversal")
    source_path = canonical_path_without_symlinks(requested_source, "CLOSE source")
    candidate_path = canonical_path_without_symlinks(requested_candidate, "CLOSE candidate")
    if not source_path.is_dir():
        raise ValidationError(f"source must be a real workspace directory: {source_path}")
    if candidate_path.exists() or candidate_path.is_symlink():
        raise ValidationError(f"candidate must not exist: {candidate_path}")
    if not candidate_path.parent.is_dir() or candidate_path.parent.is_symlink():
        raise ValidationError(f"candidate parent must be a real directory: {candidate_path.parent}")
    if (
        candidate_path == source_path
        or candidate_path.is_relative_to(source_path)
        or source_path.is_relative_to(candidate_path)
    ):
        raise ValidationError("source and candidate must be disjoint directories")

    _, attested_snapshot = validate_readiness_attestation(
        source_path,
        readiness_attestation,
        candidate=candidate_path,
    )
    rendered = render_closed_feature(source_path)
    _require_attested_snapshot(source_path, attested_snapshot)
    stage = Path(
        tempfile.mkdtemp(prefix=f".{candidate_path.name}.close-stage-", dir=candidate_path.parent)
    )
    stage_identity = _directory_identity(stage, "CLOSE stage")
    try:
        (stage / "feature_spec.md").write_bytes(rendered)
        external_link_groups: dict[tuple[int, int], ExternalLinkGroup] = {}
        for child in sorted(source_path.iterdir(), key=lambda path: path.name):
            if child.name in {"feature_spec.md", "shared"} or _ignored(Path(child.name)):
                continue
            _copy_external(
                child,
                stage / child.name,
                Path(child.name),
                external_link_groups,
            )
        _validate_external_link_groups(external_link_groups)

        validate_workspace(stage)
        validate_close_transition(source_path, stage)
        _require_attested_snapshot(source_path, attested_snapshot)
        if candidate_path.exists() or candidate_path.is_symlink():
            raise ValidationError(f"candidate appeared before publication: {candidate_path}")
        os.replace(stage, candidate_path)
        _require_directory_identity(
            candidate_path,
            stage_identity,
            "promoted CLOSE candidate",
        )
        try:
            _require_attested_snapshot(source_path, attested_snapshot)
        except Exception:
            _rollback_promoted_candidate(candidate_path, stage, stage_identity)
            raise
        return candidate_path
    finally:
        if _lexists(stage):
            _remove_owned_directory(stage, stage_identity, "owned CLOSE stage")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--readiness-attestation", type=Path, required=True)
    args = parser.parse_args()
    try:
        built = build_closed_candidate(
            args.source,
            args.candidate,
            readiness_attestation=args.readiness_attestation,
        )
    except (OSError, UnicodeError, ValidationError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    print(f"PASS: deterministic CLOSE candidate built at {built}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
