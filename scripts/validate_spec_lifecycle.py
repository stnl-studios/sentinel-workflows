#!/usr/bin/env python3
"""Structural validator for stnl-spec-lifecycle-manager workspaces.

This parser intentionally recognizes only the current Markdown item contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


HEADER_FIELDS = [
    "purpose",
    "status",
    "read_when",
    "do_not_read_when",
    "contains",
    "owner",
    "update_policy",
]
HEADER_STATUSES = {"draft", "ready", "blocked", "done", "closed", "not_applicable"}
FEATURE_ACTIVE_STATUSES = {"draft", "ready", "blocked"}
CANONICAL_PREFIXES = ("R", "AC", "D", "C", "RK", "Q")
CANONICAL_ID_PATTERN = r"(?:AC|RK|R|D|C|Q)-\d{3}"
CANONICAL_ID_RE = re.compile(rf"^{CANONICAL_ID_PATTERN}$")
CANONICAL_HEADING_RE = re.compile(rf"^### (?P<id>{CANONICAL_ID_PATTERN}) — (?P<title>\S.*)$")
METADATA_RE = re.compile(r"^- (?P<field>[a-z_]+): (?P<value>.+)$")
OS_METADATA_NAMES = {".DS_Store", "__MACOSX"}
TEMPLATE_PLACEHOLDER_RE = re.compile(r"{{(?:FEATURE_NAME|OBJECTIVE|ITEM_TITLE|CONTENT)}}")
RESUME_MANIFEST_VERSION = 1
RESUME_MANIFEST_FIELDS = {
    "schema_version",
    "mode",
    "workspace_identity",
    "allowed_feature_sections",
    "allowed_existing_ids",
    "allowed_new_ids",
    "allowed_status_transitions",
    "allowed_record_status_transitions",
}
RESUME_IDENTITY_FIELDS = {"h1", "pre_state_sha256"}
RESUME_STATUS_TRANSITION_FIELDS = {"path", "from", "to"}
RESUME_RECORD_STATUS_TRANSITION_FIELDS = {"path", "id", "from", "to"}
RESUME_STATUS_PATH_RE = re.compile(
    r"(?:feature_spec\.md|shared/(?:requirements|acceptance-criteria|decisions|constraints|risks|questions)\.md)"
)
RESUME_RECORD_STATUS_TRANSITIONS = {
    "R": {
        ("in_scope", "out_of_scope"),
        ("out_of_scope", "in_scope"),
        ("in_scope", "superseded"),
        ("out_of_scope", "superseded"),
        ("in_scope", "retired"),
        ("out_of_scope", "retired"),
    },
    "AC": {("active", "superseded"), ("active", "dropped"), ("active", "retired")},
    "D": {("accepted", "superseded"), ("accepted", "retired")},
    "C": {("active", "retired")},
    "RK": {("active", "retired")},
    "Q": {
        ("open", "resolved"),
        ("open", "bypassed"),
        ("open", "dropped"),
    },
}


@dataclass(frozen=True)
class Category:
    key: str
    filename: str
    prefix: str
    root_heading: str
    fields: tuple[str, ...]
    required: tuple[str, ...]
    statuses: frozenset[str]
    sections: tuple[str, ...]


CATEGORIES = (
    Category(
        "requirements",
        "requirements.md",
        "R",
        "Requirements",
        ("status", "retired_reason", "coverage_justification", "references"),
        ("status",),
        frozenset({"in_scope", "out_of_scope", "superseded", "retired"}),
        (),
    ),
    Category(
        "acceptance_criteria",
        "acceptance-criteria.md",
        "AC",
        "Acceptance Criteria",
        ("status", "retired_reason", "verifies", "blocked_by", "references"),
        ("status", "verifies"),
        frozenset({"active", "superseded", "dropped", "retired"}),
        (),
    ),
    Category(
        "decisions",
        "decisions.md",
        "D",
        "Decisions",
        ("status", "retired_reason", "references"),
        ("status",),
        frozenset({"accepted", "superseded", "retired"}),
        ("Contexto", "Decisão", "Impacto"),
    ),
    Category(
        "constraints",
        "constraints.md",
        "C",
        "Constraints",
        ("status", "retired_reason", "references"),
        ("status",),
        frozenset({"active", "retired"}),
        ("Restrição", "Razão"),
    ),
    Category(
        "risks",
        "risks.md",
        "RK",
        "Risks",
        ("status", "retired_reason", "impact", "references"),
        ("status", "impact"),
        frozenset({"active", "retired"}),
        ("Risco", "Mitigação"),
    ),
    Category(
        "questions",
        "questions.md",
        "Q",
        "Questions",
        ("status", "classification", "blocks", "resolved_by", "linked_decision", "references"),
        ("status", "classification"),
        frozenset({"open", "resolved", "bypassed", "dropped"}),
        ("Pergunta", "Por que importa", "Resolução"),
    ),
)
CATEGORY_BY_KEY = {category.key: category for category in CATEGORIES}
CATEGORY_BY_FILENAME = {category.filename: category for category in CATEGORIES}
CATEGORY_BY_PREFIX = {category.prefix: category for category in CATEGORIES}
CATEGORY_ORDER = [category.key for category in CATEGORIES]
EXPECTED_ARTIFACT_PATHS = {
    category.key: f"shared/{category.filename}" for category in CATEGORIES
}

CLOSED_SECTION_PREFIX = {
    "Requirements": "R",
    "Final Acceptance Criteria": "AC",
    "Durable Decisions": "D",
    "Relevant Constraints": "C",
    "Relevant Risks": "RK",
    "Durable Resolved Questions": "Q",
}

ACTIVE_SECTIONS = [
    "Objective",
    "Context",
    "Scope",
    "Out of Scope",
    "Requirements",
    "Business Rules",
    "Relevant Contracts",
    "Canonical Artifact Index",
    "Blockers",
    "Selective Reading",
]
CLOSED_CORE_SECTIONS = [
    "Objective",
    "Context",
    "Final Scope",
    "Out of Scope",
    "Requirements",
    "Business Rules",
    "Important Contracts",
]


class ValidationError(ValueError):
    """Raised when a workspace violates the current lifecycle contract."""


# Raw device/inode values are used only to derive stable relative peer groups.
# The serialized snapshot records link count and peers, never host-specific inode IDs.
SnapshotEntry = tuple[str, str, str, int, tuple[str, ...]]


@dataclass(frozen=True)
class Item:
    identifier: str
    title: str
    category: Category
    metadata: dict[str, str | tuple[str, ...]]
    narrative: str
    raw_narrative: str
    sections: dict[str, str]
    path: Path
    parent_section: str | None = None

    def preservation_signature(self) -> tuple[object, ...]:
        ordered_metadata = tuple((field, self.metadata[field]) for field in self.category.fields if field in self.metadata)
        ordered_sections = tuple((name, self.sections.get(name, "")) for name in self.category.sections)
        return self.title, ordered_metadata, self.raw_narrative, ordered_sections


@dataclass(frozen=True)
class Workspace:
    root: Path
    h1: str
    status: str
    closed: bool
    items: dict[str, Item]
    sections: dict[str, str]
    artifacts: dict[str, str]
    open_questions: tuple[str, ...]
    blocking_questions: tuple[str, ...]
    broken_references: tuple[str, ...]
    documentary_gaps: tuple[str, ...]


@dataclass(frozen=True)
class ResumeStatusTransition:
    path: str
    before: str
    after: str


@dataclass(frozen=True)
class ResumeRecordStatusTransition:
    path: str
    identifier: str
    before: str
    after: str


@dataclass(frozen=True)
class ResumeManifest:
    workspace_h1: str
    pre_state_sha256: str
    feature_sections: tuple[str, ...]
    existing_ids: tuple[str, ...]
    new_ids: tuple[str, ...]
    status_transitions: tuple[ResumeStatusTransition, ...]
    record_status_transitions: tuple[ResumeRecordStatusTransition, ...]


@dataclass(frozen=True)
class RawFeatureState:
    header: bytes
    preamble: bytes
    sections: dict[str, bytes]
    order: tuple[str, ...]


@dataclass(frozen=True)
class RawSharedState:
    header: bytes
    preamble: bytes
    blocks: dict[str, bytes]
    separators: dict[str, bytes]
    order: tuple[str, ...]
    raw: bytes


def normalize(text: str) -> str:
    lines = [line.rstrip() for line in text.strip().splitlines()]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def contains_template_placeholder(text: str) -> bool:
    return TEMPLATE_PLACEHOLDER_RE.search(text) is not None


def is_non_material_retired_reason(text: str) -> bool:
    """Return whether a retirement reason is only a placeholder or deletion alias."""

    if contains_template_placeholder(text):
        return True
    normalized = "".join(
        character
        for character in unicodedata.normalize("NFKD", text.strip().casefold())
        if not unicodedata.combining(character)
    )
    if not any(character.isalnum() for character in normalized):
        return True
    words = re.findall(r"[a-z0-9]+", normalized)
    if not words:
        return False
    compact = "".join(words)
    if compact in {
        "adefinir",
        "archived",
        "arquivado",
        "arquivada",
        "deleted",
        "excluida",
        "none",
        "na",
        "notapplicable",
        "notprovided",
        "obsolete",
        "obsoleta",
        "obsoleto",
        "pending",
        "placeholder",
        "pordefinir",
        "retirado",
        "retirada",
        "retirados",
        "retiradas",
        "retired",
        "removido",
        "removida",
        "removidos",
        "removidas",
        "excluido",
        "excluidos",
        "excluidas",
        "semmotivo",
        "tbd",
        "tobedefined",
        "tobedetermined",
        "todo",
        "todolater",
        "unknown",
        "removed",
    }:
        return True
    placeholder_prefixes = {
        ("a", "definir"),
        ("a", "ser", "definida"),
        ("a", "ser", "definido"),
        ("not", "provided"),
        ("por", "definir"),
        ("por", "determinar"),
        ("sem", "motivo"),
        ("to", "be", "defined"),
        ("to", "be", "determined"),
    }
    return words[0] in {"pending", "placeholder", "tbd", "todo"} or any(
        tuple(words[: len(prefix)]) == prefix for prefix in placeholder_prefixes
    )


def fail(message: str, path: Path | None = None) -> None:
    location = f"{path}: " if path is not None else ""
    raise ValidationError(location + message)


def filesystem_component_key(component: str) -> str:
    """Return the comparison key used by case/normalization-insensitive filesystems."""

    return unicodedata.normalize("NFC", component).casefold()


def _canonical_existing_component(parent: Path, name: str, metadata: os.stat_result) -> str:
    """Recover the stored directory-entry spelling without conflating hardlink names."""

    requested_key = filesystem_component_key(name)
    matches: list[str] = []
    try:
        with os.scandir(parent) as entries:
            for entry in entries:
                if filesystem_component_key(entry.name) != requested_key:
                    continue
                try:
                    entry_metadata = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if (entry_metadata.st_dev, entry_metadata.st_ino) == (
                    metadata.st_dev,
                    metadata.st_ino,
                ):
                    if entry.name == name:
                        return name
                    matches.append(entry.name)
    except (FileNotFoundError, NotADirectoryError, PermissionError) as exc:
        fail(f"cannot canonicalize existing path component {parent / name}: {exc}")
    if len(matches) != 1:
        fail(f"cannot uniquely canonicalize existing path component {parent / name}")
    return matches[0]


def canonical_path_without_symlinks(path: Path, label: str) -> Path:
    """Canonicalize trusted root aliases while rejecting later symlink components."""

    if any(part == ".." for part in path.parts):
        fail(f"{label} must not contain path traversal")
    absolute = path if path.is_absolute() else Path.cwd() / path
    current = Path(absolute.anchor)
    parts = absolute.parts[1:] if absolute.anchor else absolute.parts
    for index, part in enumerate(parts):
        candidate = current / part
        try:
            metadata = candidate.lstat()
        except (FileNotFoundError, NotADirectoryError):
            return candidate.joinpath(*parts[index + 1 :])
        if stat.S_ISLNK(metadata.st_mode):
            trusted_system_alias = current == Path(absolute.anchor) and getattr(
                metadata, "st_uid", None
            ) == 0
            if not trusted_system_alias:
                fail(f"{label} must not contain symlink components: {candidate}")
            try:
                current = candidate.resolve(strict=True)
            except (OSError, RuntimeError) as exc:
                fail(f"{label} contains an invalid system path alias: {exc}")
            continue
        current = current / _canonical_existing_component(current, part, metadata)
    return current


def is_os_metadata(path: Path) -> bool:
    return any(part in OS_METADATA_NAMES or part.startswith("._") for part in path.parts)


def read_text(path: Path) -> str:
    if not path.is_file():
        fail("required file does not exist", path)
    return path.read_text(encoding="utf-8")


def parse_file_purpose_header(path: Path) -> tuple[dict[str, str], str]:
    text = read_text(path)
    match = re.match(r"# File Purpose Header\n\n```yaml\n(.*?)```\n", text, re.DOTALL)
    if match is None:
        fail("missing normalized File Purpose Header", path)
    data: dict[str, str] = {}
    order: list[str] = []
    for line in match.group(1).splitlines():
        if not line.strip() or ":" not in line:
            fail("malformed File Purpose Header line", path)
        field, value = line.split(":", 1)
        if field in data:
            fail(f"duplicate File Purpose Header field {field}", path)
        order.append(field)
        data[field] = value.strip()
    if order != HEADER_FIELDS:
        fail(f"File Purpose Header fields must be {HEADER_FIELDS}", path)
    empty_fields = [field for field in HEADER_FIELDS if not data[field]]
    if empty_fields:
        fail(f"File Purpose Header fields must be non-empty: {empty_fields}", path)
    placeholder_fields = [field for field in HEADER_FIELDS if contains_template_placeholder(data[field])]
    if placeholder_fields:
        fail(f"File Purpose Header fields contain placeholder content: {placeholder_fields}", path)
    if data["status"] not in HEADER_STATUSES:
        fail(f"invalid File Purpose Header status {data['status']!r}", path)
    if data["owner"] != "stnl-spec-lifecycle-manager":
        fail("wrong File Purpose Header owner", path)
    return data, text[match.end() :]


def validate_feature_root(text: str, path: Path) -> str:
    """Return semantic feature content after enforcing the canonical document root."""

    if not text.startswith("\n") or text.startswith("\n\n"):
        fail("feature H1 must be the first semantic content after the File Purpose Header", path)
    semantic = text[1:]
    first_line = semantic.splitlines()[0] if semantic.splitlines() else ""
    if re.fullmatch(r"# \S(?:.*\S)? - Feature SPEC", first_line) is None:
        fail("feature must start with canonical '# <name> - Feature SPEC' H1", path)
    if contains_template_placeholder(first_line):
        fail("feature H1 contains placeholder content", path)
    h1_headings = re.findall(r"(?m)^# .+$", semantic)
    if h1_headings != [first_line]:
        fail("feature must contain exactly one canonical H1", path)
    return semantic


def h2_sections(text: str, path: Path) -> tuple[dict[str, str], list[str]]:
    matches = list(re.finditer(r"^## (?P<name>[^\n]+)\n", text, re.MULTILINE))
    sections: dict[str, str] = {}
    order: list[str] = []
    for index, match in enumerate(matches):
        name = match.group("name").strip()
        if name in sections:
            fail(f"duplicate section {name!r}", path)
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[name] = normalize(text[match.end() : end])
        order.append(name)
    return sections, order


def require_sections(
    sections: dict[str, str], order: list[str], required: list[str], path: Path
) -> None:
    missing = [name for name in required if name not in sections]
    if missing:
        fail(f"missing required sections: {missing}", path)
    positions = [order.index(name) for name in required]
    if positions != sorted(positions):
        fail(f"required sections are out of order: {required}", path)
    for name in required:
        if not sections[name]:
            fail(f"section {name!r} is empty", path)
        if contains_template_placeholder(sections[name]):
            fail(f"section {name!r} contains placeholder content", path)


def validate_context(section: str, path: Path) -> None:
    matches = list(re.finditer(r"^### (?P<name>Facts|Hypotheses)\n", section, re.MULTILINE))
    if [match.group("name") for match in matches] != ["Facts", "Hypotheses"]:
        fail("Context must contain Facts then Hypotheses headings exactly once", path)
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(section)
        if not normalize(section[match.end() : end]):
            fail(f"Context subsection {match.group('name')} is empty", path)


def extract_yaml_fence(section: str, label: str, path: Path) -> list[str]:
    match = re.fullmatch(r"```yaml\n(?P<body>.*?)\n```", normalize(section), re.DOTALL)
    if match is None:
        fail(f"{label} must contain exactly one compact YAML block", path)
    return match.group("body").splitlines()


def parse_artifact_index(section: str, path: Path) -> dict[str, str]:
    lines = extract_yaml_fence(section, "Canonical Artifact Index", path)
    if lines == ["artifacts: {}"]:
        return {}
    if not lines or lines[0] != "artifacts:":
        fail("artifact index must start with 'artifacts:' or be 'artifacts: {}'", path)
    artifacts: dict[str, str] = {}
    order: list[str] = []
    for line in lines[1:]:
        match = re.fullmatch(r"  ([a-z_]+): (shared/[a-z-]+\.md)", line)
        if match is None:
            fail(f"malformed artifact index entry {line!r}", path)
        key, value = match.groups()
        if key not in CATEGORY_BY_KEY:
            fail(f"unknown artifact category {key!r}", path)
        if key in artifacts:
            fail(f"duplicate artifact category {key!r}", path)
        if value != EXPECTED_ARTIFACT_PATHS[key]:
            fail(f"wrong path for artifact category {key!r}", path)
        artifacts[key] = value
        order.append(key)
    if order != [key for key in CATEGORY_ORDER if key in artifacts]:
        fail("artifact categories are not in deterministic order", path)
    return artifacts


def parse_id_array(
    value: str,
    field: str,
    path: Path,
    *,
    allowed_prefixes: set[str] | None = None,
    allow_empty: bool = False,
) -> tuple[str, ...]:
    if not value.startswith("[") or not value.endswith("]"):
        fail(f"{field} must use [ID-001, ID-002] array syntax", path)
    inner = value[1:-1]
    values = tuple(inner.split(", ")) if inner else ()
    if not values and not allow_empty:
        fail(f"optional empty {field} must be omitted", path)
    if value != "[" + ", ".join(values) + "]":
        fail(f"{field} array spacing is not canonical", path)
    if len(values) != len(set(values)):
        fail(f"{field} contains duplicate IDs", path)
    for identifier in values:
        if CANONICAL_ID_RE.fullmatch(identifier) is None:
            fail(f"{field} contains malformed canonical ID {identifier!r}", path)
        prefix = identifier.split("-", 1)[0]
        if allowed_prefixes is not None and prefix not in allowed_prefixes:
            fail(f"{field} contains incompatible prefix in {identifier}", path)
    return values


def parse_requirement_index(section: str, path: Path) -> tuple[str, ...]:
    lines = normalize(section).splitlines()
    if lines == ["- Not established."]:
        return ()
    identifiers: list[str] = []
    for line in lines:
        match = re.fullmatch(r"- (R-\d{3})", line)
        if match is None:
            fail("Requirements must be a derived '- R-###' index or '- Not established.'", path)
        identifiers.append(match.group(1))
    if len(identifiers) != len(set(identifiers)):
        fail("Requirements index contains duplicate IDs", path)
    if identifiers != sorted(identifiers):
        fail("Requirements index must be sorted", path)
    return tuple(identifiers)


def parse_blockers(section: str, path: Path) -> tuple[tuple[str, ...], tuple[str, ...]]:
    lines = extract_yaml_fence(section, "Blockers", path)
    if len(lines) < 2:
        fail("Blockers must define blocking_questions and documentary_gaps", path)
    blocking_match = re.fullmatch(r"blocking_questions: (\[.*\])", lines[0])
    if blocking_match is None:
        fail("Blockers fields are missing or out of order", path)
    blocking_questions = parse_id_array(
        blocking_match.group(1),
        "blocking_questions",
        path,
        allowed_prefixes={"Q"},
        allow_empty=True,
    )
    gaps: tuple[str, ...]
    if lines[1] == "documentary_gaps: []":
        if len(lines) != 2:
            fail("unexpected content after documentary_gaps", path)
        gaps = ()
    elif lines[1] == "documentary_gaps:":
        gap_values: list[str] = []
        for line in lines[2:]:
            match = re.fullmatch(r"  - (\S.*)", line)
            if match is None:
                fail(f"malformed documentary gap {line!r}", path)
            value = match.group(1).strip()
            if not value or value.lower() in {"none", "n/a", "null"}:
                fail("documentary_gaps contains a non-material placeholder", path)
            gap_values.append(value)
        if not gap_values:
            fail("empty documentary_gaps list must use []", path)
        if len(gap_values) != len(set(gap_values)):
            fail("documentary_gaps contains duplicates", path)
        gaps = tuple(gap_values)
    else:
        fail("documentary_gaps is malformed or out of order", path)
    return blocking_questions, gaps


def parse_narrative_sections(narrative: str, category: Category, path: Path) -> dict[str, str]:
    if not category.sections:
        if re.search(r"(?m)^#{1,6} ", narrative):
            fail(f"{category.prefix} narrative cannot contain nested headings", path)
        return {}
    all_headings = list(re.finditer(r"^(?P<marks>#{1,6}) (?P<name>[^\n]+)\n", narrative, re.MULTILINE))
    if any(match.group("marks") != "####" for match in all_headings):
        fail(f"{category.prefix} narrative sections must use only canonical level-4 headings", path)
    matches = list(re.finditer(r"^#### (?P<name>[^\n]+)\n", narrative, re.MULTILINE))
    names = [match.group("name") for match in matches]
    if names != list(category.sections):
        fail(f"{category.prefix} narrative sections must be {list(category.sections)}", path)
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(narrative)
        content = normalize(narrative[match.end() : end])
        if not content or contains_template_placeholder(content):
            fail(f"section {match.group('name')!r} is empty or placeholder", path)
        sections[match.group("name")] = content
    return sections


def parse_items(
    text: str,
    path: Path,
    *,
    expected_prefix: str | None,
    shared_file: bool,
) -> list[Item]:
    h3_matches = list(re.finditer(r"^### (?P<heading>[^\n]+)$", text, re.MULTILINE))
    h2_matches = list(re.finditer(r"^## (?P<heading>[^\n]+)$", text, re.MULTILINE))
    canonical_matches: list[tuple[re.Match[str], re.Match[str]]] = []
    for match in h3_matches:
        full_line = "### " + match.group("heading")
        canonical = CANONICAL_HEADING_RE.fullmatch(full_line)
        if canonical is None:
            begins_like_id = re.match(rf"^(?:{CANONICAL_ID_PATTERN})\b", match.group("heading"))
            if shared_file or begins_like_id:
                fail(f"non-canonical item heading {full_line!r}", path)
            continue
        canonical_matches.append((match, canonical))

    items: list[Item] = []
    seen: set[str] = set()
    for match, canonical in canonical_matches:
        identifier = canonical.group("id")
        prefix = identifier.split("-", 1)[0]
        if expected_prefix is not None and prefix != expected_prefix:
            fail(f"prefix {prefix} is incompatible with this category file", path)
        category = CATEGORY_BY_PREFIX[prefix]
        if contains_template_placeholder(canonical.group("title")):
            fail(f"{identifier} title contains placeholder content", path)
        if identifier in seen:
            fail(f"duplicate canonical ID {identifier}", path)
        seen.add(identifier)

        next_h3 = next((candidate.start() for candidate in h3_matches if candidate.start() > match.start()), len(text))
        next_h2 = next((candidate.start() for candidate in h2_matches if candidate.start() > match.start()), len(text))
        end = min(next_h3, next_h2) if not shared_file else next_h3
        body = text[match.end() : end]
        if not body.startswith("\n\n"):
            fail(f"{identifier} must have one blank line before metadata", path)
        lines = body[2:].splitlines()
        metadata_lines: list[tuple[str, str]] = []
        index = 0
        while index < len(lines) and lines[index].startswith("- "):
            metadata_match = METADATA_RE.fullmatch(lines[index])
            if metadata_match is None:
                fail(f"malformed metadata line in {identifier}: {lines[index]!r}", path)
            metadata_lines.append((metadata_match.group("field"), metadata_match.group("value")))
            index += 1
        if not metadata_lines:
            fail(f"{identifier} has no metadata", path)
        if index >= len(lines) or lines[index] != "":
            fail(f"{identifier} metadata must be followed by one blank line", path)
        raw_narrative_lines = lines[index + 1 :]
        while raw_narrative_lines and raw_narrative_lines[-1] == "":
            raw_narrative_lines.pop()
        raw_narrative = "\n".join(raw_narrative_lines)
        narrative = normalize(raw_narrative)
        if not narrative:
            fail(f"{identifier} has no narrative content", path)
        if lines[index + 1] == "":
            fail(f"{identifier} metadata must be followed by exactly one blank line", path)
        if contains_template_placeholder(body):
            fail(f"{identifier} contains placeholder content", path)
        if re.search(r"(?m)^```(?:yaml|yml|markdown)\s*$", narrative, re.IGNORECASE):
            fail(f"{identifier} contains a forbidden item wrapper", path)
        if re.search(r"(?im)^\s*-?\s*id\s*:", body):
            fail(f"{identifier} repeats its ID in the item body", path)

        field_order = [field for field, _ in metadata_lines]
        if len(field_order) != len(set(field_order)):
            fail(f"{identifier} contains duplicate metadata fields", path)
        if any(field not in category.fields for field in field_order):
            unknown = [field for field in field_order if field not in category.fields]
            fail(f"{identifier} contains unsupported metadata fields {unknown}", path)
        expected_order = [field for field in category.fields if field in field_order]
        if field_order != expected_order:
            fail(f"{identifier} metadata order must be {expected_order}", path)
        missing = [field for field in category.required if field not in field_order]
        if missing:
            fail(f"{identifier} is missing required metadata {missing}", path)
        if field_order[0] != "status":
            fail(f"{identifier} metadata must start with status", path)

        metadata: dict[str, str | tuple[str, ...]] = {}
        for field, raw_value in metadata_lines:
            if raw_value.casefold() == "null":
                fail(f"{identifier} uses null for {field}; omit non-applicable optional fields", path)
            if field == "verifies":
                metadata[field] = parse_id_array(raw_value, field, path, allowed_prefixes={"R"})
            elif field == "blocked_by":
                metadata[field] = parse_id_array(raw_value, field, path, allowed_prefixes={"Q"})
            elif field == "blocks":
                metadata[field] = parse_id_array(
                    raw_value, field, path, allowed_prefixes={"AC"}, allow_empty=True
                )
            elif field == "references":
                metadata[field] = parse_id_array(raw_value, field, path)
            else:
                metadata[field] = raw_value

        status = metadata["status"]
        if not isinstance(status, str) or status not in category.statuses:
            fail(f"{identifier} has invalid status {status!r}", path)
        retired_reason = metadata.get("retired_reason")
        if status == "retired":
            if (
                not isinstance(retired_reason, str)
                or not retired_reason.strip()
                or is_non_material_retired_reason(retired_reason)
            ):
                fail(f"{identifier} retired state requires a non-placeholder retired_reason", path)
        elif retired_reason is not None:
            fail(f"{identifier} retired_reason is allowed only for retired records", path)
        if category.prefix == "RK" and metadata["impact"] not in {"low", "medium", "high"}:
            fail(f"{identifier} has invalid impact {metadata['impact']!r}", path)
        references = metadata.get("references", ())
        if identifier in references:
            fail(f"{identifier} has an improper self-reference", path)

        sections = parse_narrative_sections(narrative, category, path)
        if category.prefix == "R":
            justification = metadata.get("coverage_justification")
            if justification is not None:
                if status != "in_scope":
                    fail(f"{identifier} coverage_justification is allowed only for in_scope requirements", path)
                if not isinstance(justification, str):
                    fail(f"{identifier} coverage_justification must be textual", path)
                if justification.strip().casefold() in {
                    "none",
                    "n/a",
                    "not applicable",
                    "pending",
                    "tbd",
                    "unknown",
                } or contains_template_placeholder(justification):
                    fail(f"{identifier} coverage_justification contains placeholder content", path)
        if category.prefix == "Q":
            classification = metadata.get("classification")
            if classification not in {"blocking", "non_blocking", "irrelevant"}:
                fail(f"{identifier} has invalid classification {classification!r}", path)
            resolved_by = metadata.get("resolved_by")
            linked_decision = metadata.get("linked_decision")
            resolution = sections["Resolução"]
            if status == "open":
                if classification == "irrelevant":
                    fail(f"{identifier} irrelevant questions cannot remain open", path)
                if classification == "blocking" and "blocks" not in metadata:
                    fail(f"{identifier} open blocking state requires blocks", path)
                if classification != "blocking" and "blocks" in metadata:
                    fail(f"{identifier} non-blocking open state cannot contain blocks", path)
                if resolved_by is not None or linked_decision is not None:
                    fail(f"{identifier} open state cannot contain final-state metadata", path)
                if resolution != "Pendente.":
                    fail(f"{identifier} open state must use 'Pendente.' resolution", path)
            else:
                if "blocks" in metadata:
                    fail(f"{identifier} final state cannot contain blocks", path)
                if resolved_by not in {"answer", "decision", "constraint", "scope_change"}:
                    fail(f"{identifier} final state requires valid resolved_by", path)
                if resolution.strip().casefold() in {
                    "pendente.",
                    "pending",
                    "tbd",
                    "none",
                    "n/a",
                    "unknown",
                } or contains_template_placeholder(resolution):
                    fail(f"{identifier} final state requires an explicit non-placeholder resolution", path)
                if status == "dropped" and resolved_by != "scope_change":
                    fail(f"{identifier} dropped state requires resolved_by: scope_change", path)
                if classification == "irrelevant" and status != "dropped":
                    fail(f"{identifier} irrelevant classification requires dropped status", path)
                if resolved_by == "decision":
                    if not isinstance(linked_decision, str) or re.fullmatch(r"D-\d{3}", linked_decision) is None:
                        fail(f"{identifier} decision resolution requires linked_decision: D-*", path)
                elif linked_decision is not None:
                    fail(f"{identifier} linked_decision requires resolved_by: decision", path)

        parent_section: str | None = None
        if not shared_file:
            preceding = [candidate for candidate in h2_matches if candidate.start() < match.start()]
            parent_section = preceding[-1].group("heading") if preceding else None
            expected_parent_prefix = CLOSED_SECTION_PREFIX.get(parent_section or "")
            if expected_parent_prefix != prefix:
                fail(f"{identifier} is under incompatible closed section {parent_section!r}", path)

        items.append(
            Item(
                identifier=identifier,
                title=canonical.group("title"),
                category=category,
                metadata=metadata,
                narrative=narrative,
                raw_narrative=raw_narrative,
                sections=sections,
                path=path,
                parent_section=parent_section,
            )
        )
    return items


def parse_shared_file(path: Path, category: Category) -> list[Item]:
    header, text = parse_file_purpose_header(path)
    if text.startswith("\n"):
        text = text[1:]
    if re.search(r"(?m)^```(?:yaml|yml)\s*$", text, re.IGNORECASE):
        fail("shared category files cannot contain YAML beyond the File Purpose Header", path)
    root_heading = f"# {category.root_heading}"
    if not text.startswith(root_heading + "\n\n"):
        fail(f"shared category file must start with '# {category.root_heading}' root heading", path)
    h1_headings = re.findall(r"(?m)^# .+$", text)
    if h1_headings != [root_heading]:
        fail("shared category file must contain exactly one expected root heading", path)
    if re.search(r"(?m)^## .+$", text):
        fail("shared category files cannot contain extra level-2 headings", path)
    item_region = text[len(root_heading) + 2 :]
    first_item = re.search(r"(?m)^### .+$", item_region)
    if first_item is None:
        fail("materialized category file is semantically empty", path)
    if normalize(item_region[: first_item.start()]):
        fail("shared category file contains content before the first canonical item", path)
    items = parse_items(text, path, expected_prefix=category.prefix, shared_file=True)
    if not items:
        fail("materialized category file is semantically empty", path)
    if category.prefix == "Q":
        has_blocking = any(
            item.metadata["status"] == "open" and item.metadata["classification"] == "blocking"
            for item in items
        )
        expected_status = "blocked" if has_blocking else "ready"
        if header["status"] != expected_status:
            fail(f"questions header status must be {expected_status}", path)
    elif header["status"] != "ready":
        fail("materialized non-question category header status must be ready", path)
    return items


def collect_relationship_state(items: dict[str, Item]) -> tuple[set[str], list[str]]:
    missing: set[str] = set()
    errors: list[str] = []
    question_pairs: set[tuple[str, str]] = set()
    criterion_pairs: set[tuple[str, str]] = set()
    for item in items.values():
        for field in ("verifies", "blocks", "blocked_by", "references"):
            if field not in item.metadata:
                continue
            values = item.metadata.get(field, ())
            if not isinstance(values, tuple):
                continue
            for target in values:
                if target not in items:
                    missing.add(target)
            if field == "references" and item.category.prefix == "R" and any(
                target.startswith("AC-") for target in values
            ):
                errors.append(f"{item.identifier} duplicates coverage through references; AC.verifies is authoritative")
            if field == "references" and item.category.prefix == "AC" and any(
                target.startswith("R-") for target in values
            ):
                errors.append(f"{item.identifier} duplicates verifies through references")
            if field == "verifies":
                if item.category.prefix != "AC":
                    errors.append(f"{item.identifier} uses verifies outside an acceptance criterion")
                    continue
                for target in values:
                    target_item = items.get(target)
                    if (
                        item.metadata["status"] == "active"
                        and target_item is not None
                        and target_item.metadata["status"] != "in_scope"
                    ):
                        errors.append(f"{item.identifier} verifies non-in-scope requirement {target}")
            elif field == "blocks":
                if item.category.prefix != "Q":
                    errors.append(f"{item.identifier} uses blocks outside a question")
                    continue
                if item.metadata["status"] != "open":
                    errors.append(f"{item.identifier} non-open question cannot contain blocks")
                    continue
                question_pairs.update((item.identifier, target) for target in values)
            elif field == "blocked_by":
                if item.category.prefix != "AC":
                    errors.append(f"{item.identifier} uses blocked_by outside an acceptance criterion")
                    continue
                if item.metadata["status"] != "active":
                    errors.append(f"{item.identifier} non-active acceptance criterion cannot contain blocked_by")
                    continue
                for target in values:
                    target_item = items.get(target)
                    if target_item is not None and target_item.metadata["status"] != "open":
                        errors.append(f"{item.identifier} blocked_by points to non-open question {target}")
                criterion_pairs.update((target, item.identifier) for target in values)
        linked = item.metadata.get("linked_decision")
        if isinstance(linked, str) and linked not in items:
            missing.add(linked)
    for pair in sorted(question_pairs - criterion_pairs):
        errors.append(f"missing inverse blocked_by link for {pair[0]} -> {pair[1]}")
    for pair in sorted(criterion_pairs - question_pairs):
        errors.append(f"missing inverse blocks link for {pair[0]} -> {pair[1]}")
    return missing, errors


def validate_requirement_coverage(items: dict[str, Item], path: Path, *, complete: bool) -> None:
    requirements = {
        identifier: item
        for identifier, item in items.items()
        if item.category.prefix == "R" and item.metadata["status"] == "in_scope"
    }
    active_criteria = {
        identifier: item
        for identifier, item in items.items()
        if item.category.prefix == "AC" and item.metadata["status"] == "active"
    }
    covered: dict[str, list[str]] = {identifier: [] for identifier in requirements}
    for criterion in active_criteria.values():
        verifies = criterion.metadata.get("verifies", ())
        if not isinstance(verifies, tuple) or not verifies:
            fail(f"{criterion.identifier} active criterion must verify at least one requirement", path)
        for requirement_id in verifies:
            if requirement_id in covered:
                covered[requirement_id].append(criterion.identifier)

    for identifier, requirement in requirements.items():
        justification = requirement.metadata.get("coverage_justification")
        if covered[identifier] and justification is not None:
            fail(f"{identifier} has stale coverage_justification despite active AC coverage", path)
        if complete and not covered[identifier] and justification is None:
            fail(f"{identifier} has no active AC coverage or formal coverage_justification", path)

    if complete:
        if not requirements:
            fail("ready or closed SPEC requires at least one in-scope requirement", path)
        if not active_criteria:
            fail("ready or closed SPEC requires at least one active acceptance criterion", path)


def validate_active(root: Path, feature: Path, header: dict[str, str], text: str) -> Workspace:
    if header["status"] not in FEATURE_ACTIVE_STATUSES:
        fail(f"active feature status must be one of {sorted(FEATURE_ACTIVE_STATUSES)}", feature)
    text = validate_feature_root(text, feature)
    sections, order = h2_sections(text, feature)
    require_sections(sections, order, ACTIVE_SECTIONS, feature)
    if order != ACTIVE_SECTIONS:
        fail(f"active feature sections must be exactly {ACTIVE_SECTIONS}", feature)
    if len(re.findall(r"(?m)^```(?:yaml|yml)\s*$", text, re.IGNORECASE)) != 2:
        fail("active feature YAML is limited to Artifact Index and Blockers", feature)
    h3_headings = re.findall(r"(?m)^### ([^\n]+)$", text)
    if h3_headings != ["Facts", "Hypotheses"]:
        fail("active feature permits only Context Facts and Hypotheses level-3 headings", feature)
    if re.search(r"(?m)^#{4,6} ", text):
        fail("active feature cannot contain nested level-4 through level-6 headings", feature)
    validate_context(sections["Context"], feature)
    artifacts = parse_artifact_index(sections["Canonical Artifact Index"], feature)
    requirement_index = parse_requirement_index(sections["Requirements"], feature)
    blocking_index, gaps = parse_blockers(sections["Blockers"], feature)

    shared = root / "shared"
    actual_categories: dict[str, Path] = {}
    if shared.exists() or shared.is_symlink():
        if not shared.is_dir() or shared.is_symlink():
            fail("shared must be a real directory", shared)
        for child in sorted(shared.iterdir()):
            if is_os_metadata(child.relative_to(root)):
                continue
            if child.is_symlink() or not child.is_file() or child.name not in CATEGORY_BY_FILENAME:
                fail(f"unexpected lifecycle artifact {child.name!r}", child)
            if child.lstat().st_nlink != 1:
                fail("lifecycle authority must be a single-link regular file", child)
            category = CATEGORY_BY_FILENAME[child.name]
            actual_categories[category.key] = child
        if not actual_categories:
            fail("empty shared/ directory must be absent", shared)
    if set(artifacts) != set(actual_categories):
        fail(
            f"artifact index does not exactly match materialized categories; index={sorted(artifacts)}, files={sorted(actual_categories)}",
            feature,
        )
    for key, relative in artifacts.items():
        if root / relative != actual_categories[key]:
            fail(f"indexed artifact path does not resolve for {key}", feature)

    items: dict[str, Item] = {}
    for category in CATEGORIES:
        path = actual_categories.get(category.key)
        if path is None:
            continue
        for item in parse_shared_file(path, category):
            if item.identifier in items:
                fail(f"duplicate canonical ID across workspace: {item.identifier}", path)
            items[item.identifier] = item

    actual_open = tuple(sorted(
        identifier for identifier, item in items.items()
        if item.category.prefix == "Q" and item.metadata["status"] == "open"
    ))
    actual_blocking = tuple(sorted(
        identifier for identifier, item in items.items()
        if item.category.prefix == "Q"
        and item.metadata["status"] == "open"
        and item.metadata["classification"] == "blocking"
    ))
    if blocking_index != actual_blocking:
        fail(f"blocking_questions must exactly equal {list(actual_blocking)}", feature)
    if tuple(sorted(blocking_index)) != blocking_index:
        fail("blocking_questions must be sorted", feature)

    actual_requirements = tuple(sorted(
        identifier for identifier, item in items.items() if item.category.prefix == "R"
    ))
    if requirement_index != actual_requirements:
        fail(f"Requirements index must exactly equal {list(actual_requirements)}", feature)
    if not actual_requirements and sections["Requirements"] != "- Not established.":
        fail("a workspace without canonical requirements must use '- Not established.'", feature)

    missing, relationship_errors = collect_relationship_state(items)
    if missing:
        fail(f"calculated broken_references: {sorted(missing)}", feature)
    if relationship_errors:
        fail(relationship_errors[0], feature)
    validate_requirement_coverage(items, feature, complete=header["status"] == "ready")

    if header["status"] == "ready":
        if "requirements" not in artifacts:
            fail("ready SPEC requires indexed requirements", feature)
        if "acceptance_criteria" not in artifacts:
            fail("ready SPEC requires indexed acceptance criteria", feature)
        active_criteria = [
            item for item in items.values()
            if item.category.prefix == "AC" and item.metadata["status"] == "active"
        ]
        if not active_criteria:
            fail("ready SPEC requires at least one active acceptance criterion", feature)
        if any("blocked_by" in item.metadata for item in active_criteria):
            fail("ready SPEC cannot have active acceptance criteria blocked_by open questions", feature)

    blockers_present = bool(actual_blocking or gaps)
    if actual_blocking and header["status"] != "blocked":
        fail("an open blocking question requires feature status blocked", feature)
    if header["status"] == "ready" and blockers_present:
        fail("a ready SPEC cannot have blocking questions or documentary gaps", feature)
    if header["status"] == "blocked" and not blockers_present:
        fail("blocked feature status requires an indexed documentary blocker", feature)

    return Workspace(
        root=root,
        h1=text.splitlines()[0],
        status=header["status"],
        closed=False,
        items=items,
        sections=sections,
        artifacts=artifacts,
        open_questions=actual_open,
        blocking_questions=actual_blocking,
        broken_references=tuple(sorted(missing)),
        documentary_gaps=gaps,
    )


def validate_closed(root: Path, feature: Path, header: dict[str, str], text: str) -> Workspace:
    if header["status"] != "closed":
        fail("closed validator requires feature status closed", feature)
    if (root / "shared").exists() or (root / "shared").is_symlink():
        fail("closed workspace retains shared/ lifecycle residue", root / "shared")
    text = validate_feature_root(text, feature)
    sections, order = h2_sections(text, feature)
    require_sections(sections, order, CLOSED_CORE_SECTIONS, feature)
    allowed_order = [
        "Objective",
        "Context",
        "Final Scope",
        "Out of Scope",
        "Requirements",
        "Business Rules",
        "Final Acceptance Criteria",
        "Durable Decisions",
        "Relevant Constraints",
        "Relevant Risks",
        "Important Contracts",
        "Durable Resolved Questions",
    ]
    expected_order = [name for name in allowed_order if name in sections]
    if order != expected_order:
        fail(f"closed feature sections must follow {expected_order}", feature)
    if re.search(r"(?m)^```(?:yaml|yml)\s*$", text, re.IGNORECASE):
        fail("closed feature cannot contain YAML beyond the File Purpose Header", feature)
    for heading in re.findall(r"(?m)^### ([^\n]+)$", text):
        if heading in {"Facts", "Hypotheses"}:
            continue
        if CANONICAL_HEADING_RE.fullmatch("### " + heading) is None:
            fail(f"closed feature contains non-canonical level-3 heading {heading!r}", feature)
    if re.search(r"(?m)^#{5,6} ", text):
        fail("closed feature cannot contain level-5 or level-6 headings", feature)
    closed_h2 = list(re.finditer(r"(?m)^## [^\n]+$", text))
    closed_h3 = list(re.finditer(r"(?m)^### [^\n]+$", text))
    for h4 in re.finditer(r"(?m)^#### [^\n]+$", text):
        previous_h2 = next((match for match in reversed(closed_h2) if match.start() < h4.start()), None)
        previous_h3 = next((match for match in reversed(closed_h3) if match.start() < h4.start()), None)
        if (
            previous_h3 is None
            or CANONICAL_HEADING_RE.fullmatch(previous_h3.group(0)) is None
            or (previous_h2 is not None and previous_h3.start() < previous_h2.start())
        ):
            fail("closed feature has a level-4 heading outside a canonical record", feature)
    validate_context(sections["Context"], feature)
    for forbidden in ("Canonical Artifact Index", "Blockers", "Selective Reading"):
        if forbidden in sections:
            fail(f"closed feature retains active-only section {forbidden!r}", feature)
    parsed = parse_items(text, feature, expected_prefix=None, shared_file=False)
    items: dict[str, Item] = {}
    for item in parsed:
        if item.identifier in items:
            fail(f"duplicate canonical ID in closed workspace: {item.identifier}", feature)
        items[item.identifier] = item
    for section_name, prefix in CLOSED_SECTION_PREFIX.items():
        if section_name not in sections:
            continue
        first_line = sections[section_name].splitlines()[0]
        if re.fullmatch(rf"### {prefix}-\d{{3}} — \S.*", first_line) is None:
            fail(f"closed canonical section {section_name!r} contains a preamble", feature)
        if not any(item.category.prefix == prefix for item in items.values()):
            fail(f"closed feature contains empty canonical section {section_name!r}", feature)
    missing, relationship_errors = collect_relationship_state(items)
    if missing:
        fail(f"closed feature has broken internal references: {sorted(missing)}", feature)
    if relationship_errors:
        fail(relationship_errors[0], feature)
    if any(item.category.prefix == "Q" and item.metadata["status"] == "open" for item in items.values()):
        fail("closed feature contains an open question", feature)
    validate_requirement_coverage(items, feature, complete=True)
    return Workspace(
        root=root,
        h1=text.splitlines()[0],
        status="closed",
        closed=True,
        items=items,
        sections=sections,
        artifacts={},
        open_questions=(),
        blocking_questions=(),
        broken_references=(),
        documentary_gaps=(),
    )


def validate_workspace(root: str | Path) -> Workspace:
    requested_root = Path(root).expanduser()
    if requested_root.is_symlink():
        fail("workspace root must not be a symlink", requested_root)
    workspace_root = canonical_path_without_symlinks(requested_root, "workspace root")
    if not workspace_root.is_dir():
        fail("workspace root must be a real directory", workspace_root)
    feature = workspace_root / "feature_spec.md"
    try:
        feature_metadata = feature.lstat()
    except FileNotFoundError:
        fail("required file does not exist", feature)
    if stat.S_ISLNK(feature_metadata.st_mode):
        fail("feature_spec.md must be a real file", feature)
    if not stat.S_ISREG(feature_metadata.st_mode):
        fail("feature_spec.md must be a real regular file", feature)
    if feature_metadata.st_nlink != 1:
        fail("feature_spec.md must be a single-link regular file", feature)
    header, text = parse_file_purpose_header(feature)
    if header["status"] == "closed":
        return validate_closed(workspace_root, feature, header, text)
    return validate_active(workspace_root, feature, header, text)


def _filesystem_snapshot(root: Path, *, external_only: bool) -> tuple[SnapshotEntry, ...]:
    inventory: list[tuple[Path, str, str, int, tuple[int, int] | None]] = []
    link_groups: dict[tuple[int, int], list[str]] = {}
    for path in sorted(root.rglob("*"), key=lambda value: value.as_posix()):
        relative = path.relative_to(root)
        if is_os_metadata(relative):
            continue
        relative_name = relative.as_posix()
        metadata = path.lstat()
        if path.is_symlink():
            kind = "symlink"
            link_key: tuple[int, int] | None = (metadata.st_dev, metadata.st_ino)
        elif path.is_dir():
            kind = "directory"
            link_key = None
        elif path.is_file():
            kind = "file"
            link_key = (metadata.st_dev, metadata.st_ino)
        else:
            fail("workspace contains an unsupported filesystem entry", path)
        if link_key is not None:
            link_groups.setdefault(link_key, []).append(relative_name)
        link_count = metadata.st_nlink if link_key is not None else 0
        inventory.append((path, relative_name, kind, link_count, link_key))

    snapshot: list[SnapshotEntry] = []
    for path, relative_name, kind, link_count, link_key in inventory:
        relative = Path(relative_name)
        if external_only and (
            relative.parts[0] == "shared" or relative_name == "feature_spec.md"
        ):
            continue
        peers = () if link_key is None else tuple(sorted(link_groups[link_key]))
        if kind == "symlink":
            payload = path.readlink().as_posix()
        elif kind == "directory":
            payload = ""
        else:
            payload = hashlib.sha256(path.read_bytes()).hexdigest()
        snapshot.append((kind, relative_name, payload, link_count, peers))
    return tuple(snapshot)


def external_snapshot(root: Path) -> tuple[SnapshotEntry, ...]:
    return _filesystem_snapshot(root, external_only=True)


def workspace_snapshot(root: Path) -> tuple[SnapshotEntry, ...]:
    return _filesystem_snapshot(root, external_only=False)


def resume_workspace_identity(root: str | Path) -> str:
    """Return the deterministic pre-state identity required by a RESUME manifest."""

    workspace = validate_workspace(root)
    encoded = json.dumps(
        workspace_snapshot(workspace.root),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(b"stnl-resume-pre-state-v1\0" + encoded).hexdigest()


def _reject_duplicate_json_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            fail(f"RESUME manifest contains duplicate JSON field {key!r}")
        result[key] = value
    return result


def _require_exact_fields(value: object, fields: set[str], label: str) -> dict[str, object]:
    if type(value) is not dict:
        fail(f"RESUME manifest {label} must be a JSON object")
    mapping = value
    actual = set(mapping)
    if actual != fields:
        unknown = sorted(actual - fields)
        missing = sorted(fields - actual)
        fail(f"RESUME manifest {label} fields are invalid; unknown={unknown}, missing={missing}")
    return mapping


def _require_string(value: object, label: str) -> str:
    if type(value) is not str or not value:
        fail(f"RESUME manifest {label} must be a non-empty string")
    return value


def _canonical_id_sort_key(identifier: str) -> tuple[int, int]:
    prefix, suffix = identifier.rsplit("-", 1)
    return CANONICAL_PREFIXES.index(prefix), int(suffix)


def _require_unique_string_array(value: object, label: str) -> tuple[str, ...]:
    if type(value) is not list or any(type(entry) is not str for entry in value):
        fail(f"RESUME manifest {label} must be an array of strings")
    entries = tuple(value)
    if len(entries) != len(set(entries)):
        fail(f"RESUME manifest {label} contains duplicate entries")
    return entries


def _manifest_path(path: object, label: str) -> str:
    value = _require_string(path, label)
    if RESUME_STATUS_PATH_RE.fullmatch(value) is None:
        fail(f"RESUME manifest {label} must be an exact lifecycle path without traversal: {value!r}")
    return value


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _load_resume_manifest(
    manifest_path: str | Path | None,
    before: Workspace,
    after_root: str | Path,
) -> ResumeManifest:
    if manifest_path is None:
        fail("RESUME transition requires a pre-state change manifest")
    requested = Path(manifest_path).expanduser()
    if requested.is_symlink():
        fail("RESUME manifest must be a real file, not a symlink", requested)
    resolved = canonical_path_without_symlinks(requested, "RESUME manifest")
    if not resolved.is_file():
        fail("RESUME manifest file does not exist", resolved)
    candidate_root = canonical_path_without_symlinks(
        Path(after_root).expanduser(), "candidate workspace"
    )
    if _is_within(resolved, before.root) or _is_within(resolved, candidate_root):
        fail("RESUME manifest must be ephemeral and outside source and candidate workspaces", resolved)
    try:
        raw = resolved.read_bytes()
        text = raw.decode("utf-8")
        value = json.loads(text, object_pairs_hook=_reject_duplicate_json_fields)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        fail(f"RESUME manifest is malformed JSON: {exc}", resolved)

    root = _require_exact_fields(value, RESUME_MANIFEST_FIELDS, "root")
    if type(root["schema_version"]) is not int or root["schema_version"] != RESUME_MANIFEST_VERSION:
        fail(f"RESUME manifest schema_version must be {RESUME_MANIFEST_VERSION}")
    if root["mode"] != "RESUME":
        fail("RESUME manifest mode must be exactly 'RESUME'")

    identity = _require_exact_fields(root["workspace_identity"], RESUME_IDENTITY_FIELDS, "workspace_identity")
    workspace_h1 = _require_string(identity["h1"], "workspace_identity.h1")
    pre_state_sha256 = _require_string(
        identity["pre_state_sha256"], "workspace_identity.pre_state_sha256"
    )
    if re.fullmatch(r"[0-9a-f]{64}", pre_state_sha256) is None:
        fail("RESUME manifest workspace_identity.pre_state_sha256 must be lowercase SHA-256")
    if workspace_h1 != before.h1:
        fail("RESUME manifest workspace H1 does not match the pre-state workspace")
    actual_identity = resume_workspace_identity(before.root)
    if pre_state_sha256 != actual_identity:
        fail("RESUME manifest pre-state identity does not match the source workspace")

    feature_sections = _require_unique_string_array(
        root["allowed_feature_sections"], "allowed_feature_sections"
    )
    unknown_sections = [name for name in feature_sections if name not in ACTIVE_SECTIONS]
    if unknown_sections:
        fail(f"RESUME manifest contains unknown or generic feature sections: {unknown_sections}")
    expected_section_order = tuple(name for name in ACTIVE_SECTIONS if name in feature_sections)
    if feature_sections != expected_section_order:
        fail("RESUME manifest allowed_feature_sections must follow canonical feature section order")

    id_arrays: dict[str, tuple[str, ...]] = {}
    for field in ("allowed_existing_ids", "allowed_new_ids"):
        entries = _require_unique_string_array(root[field], field)
        malformed = [identifier for identifier in entries if CANONICAL_ID_RE.fullmatch(identifier) is None]
        if malformed:
            fail(f"RESUME manifest {field} contains malformed IDs or generic authorization: {malformed}")
        if entries != tuple(sorted(entries, key=_canonical_id_sort_key)):
            fail(f"RESUME manifest {field} must use canonical ID order")
        id_arrays[field] = entries
    all_authorized_ids = id_arrays["allowed_existing_ids"] + id_arrays["allowed_new_ids"]
    if len(all_authorized_ids) != len(set(all_authorized_ids)):
        fail("RESUME manifest gives duplicate authority to an ID across change classes")

    transition_values = root["allowed_status_transitions"]
    if type(transition_values) is not list:
        fail("RESUME manifest allowed_status_transitions must be an array")
    transitions: list[ResumeStatusTransition] = []
    for index, entry in enumerate(transition_values):
        mapping = _require_exact_fields(
            entry,
            RESUME_STATUS_TRANSITION_FIELDS,
            f"allowed_status_transitions[{index}]",
        )
        path = _manifest_path(mapping["path"], f"allowed_status_transitions[{index}].path")
        before_status = _require_string(mapping["from"], f"allowed_status_transitions[{index}].from")
        after_status = _require_string(mapping["to"], f"allowed_status_transitions[{index}].to")
        if before_status not in HEADER_STATUSES or after_status not in HEADER_STATUSES:
            fail(f"RESUME manifest status transition for {path} contains an invalid status")
        if before_status == after_status:
            fail(f"RESUME manifest status transition for {path} must change status")
        transitions.append(ResumeStatusTransition(path, before_status, after_status))
    transition_paths = [transition.path for transition in transitions]
    if len(transition_paths) != len(set(transition_paths)):
        fail("RESUME manifest allowed_status_transitions contains duplicate paths")
    if transition_paths != sorted(transition_paths):
        fail("RESUME manifest allowed_status_transitions must use canonical path order")

    record_transition_values = root["allowed_record_status_transitions"]
    if type(record_transition_values) is not list:
        fail("RESUME manifest allowed_record_status_transitions must be an array")
    record_transitions: list[ResumeRecordStatusTransition] = []
    for index, entry in enumerate(record_transition_values):
        mapping = _require_exact_fields(
            entry,
            RESUME_RECORD_STATUS_TRANSITION_FIELDS,
            f"allowed_record_status_transitions[{index}]",
        )
        path = _manifest_path(mapping["path"], f"allowed_record_status_transitions[{index}].path")
        if path == "feature_spec.md":
            fail("RESUME manifest record status transitions must target shared category files")
        identifier = _require_string(mapping["id"], f"allowed_record_status_transitions[{index}].id")
        if CANONICAL_ID_RE.fullmatch(identifier) is None:
            fail(f"RESUME manifest record status transition contains malformed ID {identifier!r}")
        before_status = _require_string(
            mapping["from"], f"allowed_record_status_transitions[{index}].from"
        )
        after_status = _require_string(
            mapping["to"], f"allowed_record_status_transitions[{index}].to"
        )
        category = CATEGORY_BY_PREFIX[identifier.split("-", 1)[0]]
        if path != EXPECTED_ARTIFACT_PATHS[category.key]:
            fail(
                f"RESUME manifest record status transition path {path!r} is incompatible with {identifier}"
            )
        if before_status not in category.statuses or after_status not in category.statuses:
            fail(f"RESUME manifest record status transition for {identifier} has an invalid status")
        if before_status == after_status:
            fail(f"RESUME manifest record status transition for {identifier} must change status")
        if (before_status, after_status) not in RESUME_RECORD_STATUS_TRANSITIONS[category.prefix]:
            fail(
                f"RESUME manifest record status transition for {identifier} is not permitted: "
                f"{before_status} -> {after_status}"
            )
        record_transitions.append(
            ResumeRecordStatusTransition(path, identifier, before_status, after_status)
        )
    record_targets = [(transition.path, transition.identifier) for transition in record_transitions]
    if len(record_targets) != len(set(record_targets)):
        fail("RESUME manifest allowed_record_status_transitions contains duplicate targets")
    if record_targets != sorted(record_targets):
        fail("RESUME manifest allowed_record_status_transitions must use canonical path and ID order")
    unauthorized_status_ids = sorted(
        {transition.identifier for transition in record_transitions}
        - set(id_arrays["allowed_existing_ids"]),
        key=_canonical_id_sort_key,
    )
    if unauthorized_status_ids:
        fail(
            "RESUME manifest record status transitions also require allowed_existing_ids authority: "
            f"{unauthorized_status_ids}"
        )

    return ResumeManifest(
        workspace_h1=workspace_h1,
        pre_state_sha256=pre_state_sha256,
        feature_sections=feature_sections,
        existing_ids=id_arrays["allowed_existing_ids"],
        new_ids=id_arrays["allowed_new_ids"],
        status_transitions=tuple(transitions),
        record_status_transitions=tuple(record_transitions),
    )


def _raw_header_and_body(path: Path) -> tuple[bytes, bytes]:
    raw = path.read_bytes()
    match = re.match(rb"# File Purpose Header\n\n```yaml\n.*?```\n", raw, re.DOTALL)
    if match is None:
        fail("missing normalized File Purpose Header", path)
    return match.group(0), raw[match.end() :]


def _header_without_status(header: bytes, path: Path) -> bytes:
    normalized, replacements = re.subn(
        rb"(?m)^status: [^\n]+$",
        b"status: <RESUME_STATUS>",
        header,
        count=1,
    )
    if replacements != 1:
        fail("File Purpose Header status is missing", path)
    return normalized


def _raw_feature_state(path: Path) -> RawFeatureState:
    header, body = _raw_header_and_body(path)
    matches = list(re.finditer(rb"(?m)^## (?P<name>[^\n]+)\n", body))
    if not matches:
        fail("feature has no canonical sections", path)
    sections: dict[str, bytes] = {}
    order: list[str] = []
    for index, match in enumerate(matches):
        name = match.group("name").decode("utf-8")
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        sections[name] = body[match.start() : end]
        order.append(name)
    return RawFeatureState(header, body[: matches[0].start()], sections, tuple(order))


def _raw_shared_state(path: Path) -> RawSharedState:
    raw = path.read_bytes()
    header, body = _raw_header_and_body(path)
    heading_re = re.compile(
        rf"(?m)^### (?P<id>{CANONICAL_ID_PATTERN}) — [^\n]+\n".encode("utf-8")
    )
    matches = list(heading_re.finditer(body))
    if not matches:
        fail("materialized category file is semantically empty", path)
    blocks: dict[str, bytes] = {}
    separators: dict[str, bytes] = {}
    order: list[str] = []
    for index, match in enumerate(matches):
        identifier = match.group("id").decode("ascii")
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        segment = body[match.start() : end]
        block = segment.rstrip(b"\n")
        blocks[identifier] = block
        separators[identifier] = segment[len(block) :]
        order.append(identifier)
    return RawSharedState(
        header=header,
        preamble=body[: matches[0].start()],
        blocks=blocks,
        separators=separators,
        order=tuple(order),
        raw=raw,
    )


def _lifecycle_paths(workspace: Workspace) -> dict[str, Path]:
    paths = {"feature_spec.md": workspace.root / "feature_spec.md"}
    paths.update({relative: workspace.root / relative for relative in workspace.artifacts.values()})
    return paths


def _status_transitions(before: Workspace, after: Workspace) -> tuple[ResumeStatusTransition, ...]:
    source_paths = _lifecycle_paths(before)
    candidate_paths = _lifecycle_paths(after)
    transitions: list[ResumeStatusTransition] = []
    for relative in sorted(set(source_paths) & set(candidate_paths)):
        source_header, _ = parse_file_purpose_header(source_paths[relative])
        candidate_header, _ = parse_file_purpose_header(candidate_paths[relative])
        source_status = source_header["status"]
        candidate_status = candidate_header["status"]
        if source_status != candidate_status:
            transitions.append(ResumeStatusTransition(relative, source_status, candidate_status))
    return tuple(transitions)


def _record_status_transitions(
    before: Workspace,
    after: Workspace,
) -> tuple[ResumeRecordStatusTransition, ...]:
    transitions: list[ResumeRecordStatusTransition] = []
    for identifier in sorted(set(before.items) & set(after.items), key=_canonical_id_sort_key):
        source = before.items[identifier]
        candidate = after.items[identifier]
        source_status = source.metadata["status"]
        candidate_status = candidate.metadata["status"]
        if source_status != candidate_status:
            transitions.append(
                ResumeRecordStatusTransition(
                    candidate.path.relative_to(after.root).as_posix(),
                    identifier,
                    str(source_status),
                    str(candidate_status),
                )
            )
    return tuple(sorted(transitions, key=lambda value: (value.path, value.identifier)))


def _validate_resume_preservation(
    before: Workspace,
    after: Workspace,
    manifest: ResumeManifest,
) -> None:
    source_feature = _raw_feature_state(before.root / "feature_spec.md")
    candidate_feature = _raw_feature_state(after.root / "feature_spec.md")
    if source_feature.preamble != candidate_feature.preamble:
        fail("RESUME changed the feature H1 or structural preamble", after.root / "feature_spec.md")
    if source_feature.order != candidate_feature.order:
        fail("RESUME changed feature section headers or order", after.root / "feature_spec.md")
    changed_sections = tuple(
        name
        for name in source_feature.order
        if source_feature.sections[name] != candidate_feature.sections[name]
    )
    if changed_sections != manifest.feature_sections:
        fail(
            "RESUME feature section changes do not exactly match allowed_feature_sections; "
            f"actual={list(changed_sections)}, allowed={list(manifest.feature_sections)}",
            after.root / "feature_spec.md",
        )

    source_paths = _lifecycle_paths(before)
    candidate_paths = _lifecycle_paths(after)
    actual_transitions = _status_transitions(before, after)
    if actual_transitions != manifest.status_transitions:
        fail(
            "RESUME File Purpose Header status changes do not exactly match allowed_status_transitions; "
            f"actual={actual_transitions}, allowed={manifest.status_transitions}",
            after.root / "feature_spec.md",
        )
    actual_record_transitions = _record_status_transitions(before, after)
    if actual_record_transitions != manifest.record_status_transitions:
        fail(
            "RESUME canonical record status changes do not exactly match "
            "allowed_record_status_transitions; "
            f"actual={actual_record_transitions}, allowed={manifest.record_status_transitions}",
            after.root / "feature_spec.md",
        )
    transitioned_paths = {transition.path for transition in actual_transitions}
    for relative in sorted(set(source_paths) & set(candidate_paths)):
        source_header, _ = _raw_header_and_body(source_paths[relative])
        candidate_header, _ = _raw_header_and_body(candidate_paths[relative])
        if source_header != candidate_header and relative not in transitioned_paths:
            fail(f"RESUME changed unauthorized File Purpose Header bytes in {relative}", candidate_paths[relative])
        if _header_without_status(source_header, source_paths[relative]) != _header_without_status(
            candidate_header, candidate_paths[relative]
        ):
            fail(f"RESUME changed unauthorized File Purpose Header bytes in {relative}", candidate_paths[relative])

    source_shared = {
        relative: _raw_shared_state(path)
        for relative, path in source_paths.items()
        if relative != "feature_spec.md"
    }
    candidate_shared = {
        relative: _raw_shared_state(path)
        for relative, path in candidate_paths.items()
        if relative != "feature_spec.md"
    }
    changed_existing: set[str] = set()
    for relative in sorted(set(source_shared) & set(candidate_shared)):
        source = source_shared[relative]
        candidate = candidate_shared[relative]
        if source.preamble != candidate.preamble:
            fail(f"RESUME changed shared-file structural header bytes in {relative}", candidate_paths[relative])
        appended = tuple(
            sorted(
                (identifier for identifier in candidate.order if identifier not in before.items),
                key=_canonical_id_sort_key,
            )
        )
        expected_order = source.order + appended
        if candidate.order != expected_order:
            fail(f"RESUME changed canonical record order in {relative}", candidate_paths[relative])
        for identifier in sorted(
            set(source.blocks) & set(candidate.blocks), key=_canonical_id_sort_key
        ):
            if source.blocks[identifier] != candidate.blocks[identifier]:
                changed_existing.add(identifier)
            source_index = source.order.index(identifier)
            candidate_index = candidate.order.index(identifier)
            source_next = source.order[source_index + 1] if source_index + 1 < len(source.order) else None
            candidate_next = (
                candidate.order[candidate_index + 1]
                if candidate_index + 1 < len(candidate.order)
                else None
            )
            if source_next == candidate_next and source.separators[identifier] != candidate.separators[identifier]:
                fail(f"RESUME changed unauthorized record boundary bytes after {identifier}", candidate_paths[relative])
        if (
            source.raw != candidate.raw
            and source.order == candidate.order
            and not any(source.blocks[key] != candidate.blocks[key] for key in source.blocks)
            and source.header == candidate.header
        ):
            fail(f"RESUME changed unauthorized shared-file bytes in {relative}", candidate_paths[relative])

    actual_new = set(after.items) - set(before.items)
    actual_removed = set(before.items) - set(after.items)
    if actual_removed:
        fail(
            "RESUME removed canonical IDs instead of preserving tombstones: "
            f"{sorted(actual_removed, key=_canonical_id_sort_key)}",
            after.root / "feature_spec.md",
        )
    if changed_existing != set(manifest.existing_ids):
        fail(
            "RESUME changed existing IDs outside allowed_existing_ids or left unused authority; "
            f"actual={sorted(changed_existing)}, allowed={list(manifest.existing_ids)}",
            after.root / "feature_spec.md",
        )
    if actual_new != set(manifest.new_ids):
        fail(
            "RESUME new IDs do not exactly match allowed_new_ids; "
            f"actual={sorted(actual_new)}, allowed={list(manifest.new_ids)}",
            after.root / "feature_spec.md",
        )


def validate_init_transition(before_root: str | Path, after_root: str | Path) -> Workspace:
    before_path = Path(before_root)
    if before_path.exists() or before_path.is_symlink():
        fail("INIT destination must not exist", before_path)
    after = validate_workspace(after_root)
    if after.closed:
        fail("INIT cannot publish a closed SPEC", after.root / "feature_spec.md")
    for child in after.root.iterdir():
        relative = child.relative_to(after.root)
        if is_os_metadata(relative):
            continue
        if child.name not in {"feature_spec.md", "shared"}:
            fail(f"INIT created an out-of-contract path {child.name!r}", child)
    return after


def validate_resume_transition(
    before_root: str | Path,
    after_root: str | Path,
    manifest_path: str | Path | None,
) -> tuple[Workspace, Workspace]:
    before = validate_workspace(before_root)
    manifest = _load_resume_manifest(manifest_path, before, after_root)
    after = validate_workspace(after_root)
    if before.closed or after.closed:
        fail("RESUME requires active source and candidate workspaces", after.root / "feature_spec.md")
    if before.h1 != after.h1:
        fail("RESUME changed the feature H1 identity", after.root / "feature_spec.md")

    before_ids = set(before.items)
    after_ids = set(after.items)
    removed_ids = sorted(before_ids - after_ids, key=_canonical_id_sort_key)
    if removed_ids:
        fail(
            f"RESUME removed canonical IDs instead of preserving tombstones: {removed_ids}",
            after.root / "feature_spec.md",
        )
    unknown_existing = sorted(set(manifest.existing_ids) - before_ids)
    if unknown_existing:
        fail(f"RESUME manifest allowed_existing_ids are absent from the pre-state: {unknown_existing}")
    colliding_new = sorted(set(manifest.new_ids) & before_ids)
    if colliding_new:
        fail(f"RESUME manifest allowed_new_ids already exist in the pre-state: {colliding_new}")
    for identifier in sorted(before_ids & after_ids):
        source_item = before.items[identifier]
        candidate_item = after.items[identifier]
        if source_item.category.key != candidate_item.category.key:
            fail(f"RESUME changed canonical type for {identifier}", candidate_item.path)
        if source_item.title != candidate_item.title:
            fail(f"RESUME changed canonical identity/title for {identifier}", candidate_item.path)

    new_ids = sorted(after_ids - before_ids)
    for prefix in CANONICAL_PREFIXES:
        previous_suffixes = [
            int(identifier.rsplit("-", 1)[1])
            for identifier in before.items
            if identifier.startswith(prefix + "-")
        ]
        highest = max(previous_suffixes, default=0)
        invalid = [
            identifier
            for identifier in new_ids
            if identifier.startswith(prefix + "-") and int(identifier.rsplit("-", 1)[1]) <= highest
        ]
        if invalid:
            fail(
                f"RESUME reused or filled a reserved {prefix} ID at/below {prefix}-{highest:03d}: {invalid}",
                after.root / "feature_spec.md",
            )
        new_suffixes = sorted(
            int(identifier.rsplit("-", 1)[1])
            for identifier in new_ids
            if identifier.startswith(prefix + "-")
        )
        expected_suffixes = list(range(highest + 1, highest + len(new_suffixes) + 1))
        if new_suffixes != expected_suffixes:
            fail(
                f"RESUME new {prefix} IDs must continue monotonically from {prefix}-{highest + 1:03d}",
                after.root / "feature_spec.md",
            )

    _validate_resume_preservation(before, after, manifest)
    if external_snapshot(before.root) != external_snapshot(after.root):
        fail("RESUME changed a directory outside lifecycle ownership", after.root)
    return before, after


def validate_readiness_transition(
    before_root: str | Path,
    after_root: str | Path,
    scope: str,
) -> tuple[Workspace, Workspace]:
    if scope not in {"LOCAL", "GLOBAL"}:
        fail("READINESS scope must be exactly 'LOCAL' or 'GLOBAL'")
    before = validate_workspace(before_root)
    after = validate_workspace(after_root)
    if before.closed or after.closed:
        fail("READINESS operates only on active SPEC workspaces", after.root / "feature_spec.md")
    if workspace_snapshot(before.root) != workspace_snapshot(after.root):
        fail(f"READINESS {scope} check mutated the workspace", after.root)
    return before, after


def validate_close_transition(before_root: str | Path, after_root: str | Path) -> tuple[Workspace, Workspace]:
    before = validate_workspace(before_root)
    if before.closed or before.status != "ready":
        fail("CLOSE source must be an active ready SPEC", before.root / "feature_spec.md")
    if before.open_questions or before.broken_references or before.documentary_gaps:
        fail("CLOSE source still has documentary blockers", before.root / "feature_spec.md")
    after = validate_workspace(after_root)
    if not after.closed:
        fail("CLOSE result must have feature status closed", after.root / "feature_spec.md")
    if before.h1 != after.h1:
        fail("CLOSE changed the feature H1 identity", after.root / "feature_spec.md")

    section_mapping = {
        "Objective": "Objective",
        "Context": "Context",
        "Scope": "Final Scope",
        "Out of Scope": "Out of Scope",
        "Business Rules": "Business Rules",
        "Relevant Contracts": "Important Contracts",
    }
    for source_name, final_name in section_mapping.items():
        if normalize(before.sections[source_name]) != normalize(after.sections[final_name]):
            fail(f"CLOSE lost or changed durable section {source_name!r}", after.root / "feature_spec.md")

    expected = before.items
    missing = sorted(set(expected) - set(after.items))
    extra = sorted(set(after.items) - set(expected))
    if missing:
        fail(f"CLOSE discarded canonical items: {missing}", after.root / "feature_spec.md")
    if extra:
        fail(f"CLOSE invented canonical items: {extra}", after.root / "feature_spec.md")
    for identifier, source_item in expected.items():
        if source_item.preservation_signature() != after.items[identifier].preservation_signature():
            fail(f"CLOSE changed canonical content for {identifier}", after.root / "feature_spec.md")

    before_external = external_snapshot(Path(before_root).resolve())
    after_external = external_snapshot(Path(after_root).resolve())
    if before_external != after_external:
        fail("CLOSE changed an external directory, including execution/", Path(after_root).resolve())
    return before, after


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    workspace_parser = subparsers.add_parser("workspace", help="validate one active or closed workspace")
    workspace_parser.add_argument("root", type=Path)
    init_parser = subparsers.add_parser("init-transition", help="validate a nonexistent-to-active INIT transition")
    init_parser.add_argument("before", type=Path)
    init_parser.add_argument("after", type=Path)
    resume_parser = subparsers.add_parser("resume-transition", help="validate an active-to-active RESUME transition")
    resume_parser.add_argument("before", type=Path)
    resume_parser.add_argument("after", type=Path)
    resume_parser.add_argument("--manifest", type=Path, required=True)
    readiness_parser = subparsers.add_parser("readiness-transition", help="verify that READINESS was read-only")
    readiness_parser.add_argument("before", type=Path)
    readiness_parser.add_argument("after", type=Path)
    readiness_parser.add_argument("--scope", choices=("LOCAL", "GLOBAL"), required=True)
    close_parser = subparsers.add_parser("close-transition", help="validate a before/after CLOSE transition")
    close_parser.add_argument("before", type=Path)
    close_parser.add_argument("after", type=Path)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        if args.command == "workspace":
            workspace = validate_workspace(args.root)
            print(f"PASS: {workspace.root} status={workspace.status} ids={len(workspace.items)}")
        elif args.command == "init-transition":
            workspace = validate_init_transition(args.before, args.after)
            print(f"PASS: INIT published {workspace.root} status={workspace.status} ids={len(workspace.items)}")
        elif args.command == "resume-transition":
            before, after = validate_resume_transition(args.before, args.after, args.manifest)
            print(f"PASS: RESUME {before.root} -> {after.root} preserved IDs and external paths")
        elif args.command == "readiness-transition":
            before, after = validate_readiness_transition(args.before, args.after, args.scope)
            print(f"PASS: READINESS {args.scope} {before.root} -> {after.root} was read-only")
        else:
            before, after = validate_close_transition(args.before, args.after)
            print(f"PASS: CLOSE {before.root} -> {after.root} preserved exact authority and external directories")
    except ValidationError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
