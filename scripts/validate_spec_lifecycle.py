#!/usr/bin/env python3
"""Structural validator for stnl-spec-lifecycle-manager workspaces.

This parser intentionally recognizes only the current Markdown item contract.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
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
CANONICAL_PREFIXES = {"AC", "D", "C", "R", "Q"}
CANONICAL_ID_PATTERN = r"(?:AC|D|C|R|Q)-\d{3}"
CANONICAL_ID_RE = re.compile(rf"^{CANONICAL_ID_PATTERN}$")
CANONICAL_HEADING_RE = re.compile(rf"^### (?P<id>{CANONICAL_ID_PATTERN}) — (?P<title>\S.*)$")
METADATA_RE = re.compile(r"^- (?P<field>[a-z_]+): (?P<value>.+)$")
OS_METADATA_NAMES = {".DS_Store", "__MACOSX"}
TEMPLATE_PLACEHOLDER_RE = re.compile(r"{{(?:FEATURE_NAME|OBJECTIVE|ITEM_TITLE|CONTENT)}}")


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
        "acceptance_criteria",
        "acceptance-criteria.md",
        "AC",
        "Acceptance Criteria",
        ("status", "blocked_by", "references"),
        ("status",),
        frozenset({"active", "superseded", "dropped"}),
        (),
    ),
    Category(
        "decisions",
        "decisions.md",
        "D",
        "Decisions",
        ("status", "references"),
        ("status",),
        frozenset({"accepted", "superseded"}),
        ("Contexto", "Decisão", "Impacto"),
    ),
    Category(
        "constraints",
        "constraints.md",
        "C",
        "Constraints",
        ("status", "references"),
        ("status",),
        frozenset({"active", "retired"}),
        ("Restrição", "Razão"),
    ),
    Category(
        "risks",
        "risks.md",
        "R",
        "Risks",
        ("status", "impact", "references"),
        ("status", "impact"),
        frozenset({"active", "retired"}),
        ("Risco", "Mitigação"),
    ),
    Category(
        "questions",
        "questions.md",
        "Q",
        "Questions",
        ("status", "blocks", "resolved_by", "linked_decision", "references"),
        ("status",),
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
    "Final Acceptance Criteria": "AC",
    "Durable Decisions": "D",
    "Relevant Constraints": "C",
    "Relevant Risks": "R",
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


@dataclass(frozen=True)
class Item:
    identifier: str
    title: str
    category: Category
    metadata: dict[str, str | tuple[str, ...]]
    narrative: str
    sections: dict[str, str]
    path: Path
    parent_section: str | None = None

    def preservation_signature(self) -> tuple[object, ...]:
        ordered_metadata = tuple((field, self.metadata[field]) for field in self.category.fields if field in self.metadata)
        ordered_sections = tuple((name, self.sections.get(name, "")) for name in self.category.sections)
        return self.title, ordered_metadata, normalize(self.narrative), ordered_sections


@dataclass(frozen=True)
class Workspace:
    root: Path
    status: str
    closed: bool
    items: dict[str, Item]
    sections: dict[str, str]
    artifacts: dict[str, str]
    open_questions: tuple[str, ...]
    broken_references: tuple[str, ...]
    documentary_gaps: tuple[str, ...]


def normalize(text: str) -> str:
    lines = [line.rstrip() for line in text.strip().splitlines()]
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return "\n".join(lines)


def contains_template_placeholder(text: str) -> bool:
    return TEMPLATE_PLACEHOLDER_RE.search(text) is not None


def fail(message: str, path: Path | None = None) -> None:
    location = f"{path}: " if path is not None else ""
    raise ValidationError(location + message)


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
    if data["status"] not in HEADER_STATUSES:
        fail(f"invalid File Purpose Header status {data['status']!r}", path)
    if data["owner"] != "stnl-spec-lifecycle-manager":
        fail("wrong File Purpose Header owner", path)
    return data, text[match.end() :]


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


def parse_blockers(section: str, path: Path) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    lines = extract_yaml_fence(section, "Blockers", path)
    if len(lines) < 3:
        fail("Blockers must define open_questions, broken_references, and documentary_gaps", path)
    open_match = re.fullmatch(r"open_questions: (\[.*\])", lines[0])
    broken_match = re.fullmatch(r"broken_references: (\[.*\])", lines[1])
    if open_match is None or broken_match is None:
        fail("Blockers fields are missing or out of order", path)
    open_questions = parse_id_array(
        open_match.group(1), "open_questions", path, allowed_prefixes={"Q"}, allow_empty=True
    )
    broken = parse_id_array(
        broken_match.group(1), "broken_references", path, allow_empty=True
    )
    gaps: tuple[str, ...]
    if lines[2] == "documentary_gaps: []":
        if len(lines) != 3:
            fail("unexpected content after documentary_gaps", path)
        gaps = ()
    elif lines[2] == "documentary_gaps:":
        gap_values: list[str] = []
        for line in lines[3:]:
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
    return open_questions, broken, gaps


def parse_narrative_sections(narrative: str, category: Category, path: Path) -> dict[str, str]:
    if not category.sections:
        return {}
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


def validate_acceptance_criterion_narrative(identifier: str, narrative: str, path: Path) -> None:
    words = re.findall(r"\w+", narrative, re.UNICODE)
    if len(words) < 8:
        fail(f"{identifier} acceptance criterion narrative is too short", path)
    if contains_template_placeholder(narrative):
        fail(f"{identifier} contains placeholder content", path)
    if re.search(r"(?m)^#{1,6} ", narrative):
        fail(f"{identifier} acceptance criterion narrative cannot contain nested headings", path)


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
        narrative = normalize("\n".join(lines[index + 1 :]))
        if not narrative:
            fail(f"{identifier} has no narrative content", path)
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
            if field == "blocked_by":
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
        if category.prefix == "R" and metadata["impact"] not in {"low", "medium", "high"}:
            fail(f"{identifier} has invalid impact {metadata['impact']!r}", path)
        references = metadata.get("references", ())
        if identifier in references:
            fail(f"{identifier} has an improper self-reference", path)

        sections = parse_narrative_sections(narrative, category, path)
        if category.prefix == "AC":
            validate_acceptance_criterion_narrative(identifier, narrative, path)
        if category.prefix == "Q":
            resolved_by = metadata.get("resolved_by")
            linked_decision = metadata.get("linked_decision")
            resolution = sections["Resolução"]
            if status == "open":
                if "blocks" not in metadata:
                    fail(f"{identifier} open state requires blocks", path)
                if resolved_by is not None or linked_decision is not None:
                    fail(f"{identifier} open state cannot contain final-state metadata", path)
                if resolution != "Pendente.":
                    fail(f"{identifier} open state must use 'Pendente.' resolution", path)
            else:
                if "blocks" in metadata:
                    fail(f"{identifier} final state cannot contain blocks", path)
                if resolved_by not in {"answer", "decision", "constraint", "scope_change"}:
                    fail(f"{identifier} final state requires valid resolved_by", path)
                if resolution == "Pendente." or len(re.findall(r"\w+", resolution, re.UNICODE)) < 4:
                    fail(f"{identifier} final state requires an explicit resolution", path)
                if status == "dropped" and resolved_by != "scope_change":
                    fail(f"{identifier} dropped state requires resolved_by: scope_change", path)
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
        has_open = any(item.metadata["status"] == "open" for item in items)
        expected_status = "blocked" if has_open else "ready"
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
        for field in ("blocks", "blocked_by", "references"):
            if field not in item.metadata:
                continue
            values = item.metadata.get(field, ())
            if not isinstance(values, tuple):
                continue
            for target in values:
                if target not in items:
                    missing.add(target)
            if field == "blocks":
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


def validate_active(root: Path, feature: Path, header: dict[str, str], text: str) -> Workspace:
    if header["status"] not in FEATURE_ACTIVE_STATUSES:
        fail(f"active feature status must be one of {sorted(FEATURE_ACTIVE_STATUSES)}", feature)
    sections, order = h2_sections(text, feature)
    require_sections(sections, order, ACTIVE_SECTIONS, feature)
    if order != ACTIVE_SECTIONS:
        fail(f"active feature sections must be exactly {ACTIVE_SECTIONS}", feature)
    if len(re.findall(r"(?m)^```(?:yaml|yml)\s*$", text, re.IGNORECASE)) != 2:
        fail("active feature YAML is limited to Artifact Index and Blockers", feature)
    validate_context(sections["Context"], feature)
    artifacts = parse_artifact_index(sections["Canonical Artifact Index"], feature)
    open_index, broken_index, gaps = parse_blockers(sections["Blockers"], feature)

    shared = root / "shared"
    actual_categories: dict[str, Path] = {}
    if shared.exists():
        if not shared.is_dir():
            fail("shared must be a directory", shared)
        for child in sorted(shared.iterdir()):
            if is_os_metadata(child.relative_to(root)):
                continue
            if not child.is_file() or child.name not in CATEGORY_BY_FILENAME:
                fail(f"unexpected lifecycle artifact {child.name!r}", child)
            category = CATEGORY_BY_FILENAME[child.name]
            actual_categories[category.key] = child
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
    if open_index != actual_open:
        fail(f"open_questions must exactly equal {list(actual_open)}", feature)
    if tuple(sorted(open_index)) != open_index:
        fail("open_questions must be sorted", feature)

    missing, relationship_errors = collect_relationship_state(items)
    if tuple(sorted(broken_index)) != tuple(sorted(missing)):
        fail(f"broken_references must exactly equal {sorted(missing)}", feature)
    if missing:
        fail(f"broken internal references: {sorted(missing)}", feature)
    if relationship_errors:
        fail(relationship_errors[0], feature)

    if header["status"] == "ready":
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

    blockers_present = bool(actual_open or broken_index or gaps)
    if actual_open and header["status"] != "blocked":
        fail("an open question requires feature status blocked", feature)
    if header["status"] == "ready" and blockers_present:
        fail("a ready SPEC cannot have open questions, broken references, or documentary gaps", feature)
    if header["status"] == "blocked" and not blockers_present:
        fail("blocked feature status requires an indexed documentary blocker", feature)

    return Workspace(
        root=root,
        status=header["status"],
        closed=False,
        items=items,
        sections=sections,
        artifacts=artifacts,
        open_questions=actual_open,
        broken_references=broken_index,
        documentary_gaps=gaps,
    )


def validate_closed(root: Path, feature: Path, header: dict[str, str], text: str) -> Workspace:
    if header["status"] != "closed":
        fail("closed validator requires feature status closed", feature)
    if (root / "shared").exists():
        fail("closed workspace retains shared/ lifecycle residue", root / "shared")
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
    missing, relationship_errors = collect_relationship_state(items)
    if missing:
        fail(f"closed feature has broken internal references: {sorted(missing)}", feature)
    if relationship_errors:
        fail(relationship_errors[0], feature)
    if any(item.category.prefix == "Q" and item.metadata["status"] == "open" for item in items.values()):
        fail("closed feature contains an open question", feature)
    return Workspace(
        root=root,
        status="closed",
        closed=True,
        items=items,
        sections=sections,
        artifacts={},
        open_questions=(),
        broken_references=(),
        documentary_gaps=(),
    )


def validate_workspace(root: str | Path) -> Workspace:
    workspace_root = Path(root).resolve()
    feature = workspace_root / "feature_spec.md"
    header, text = parse_file_purpose_header(feature)
    if header["status"] == "closed":
        return validate_closed(workspace_root, feature, header, text)
    return validate_active(workspace_root, feature, header, text)


def durable_item(item: Item) -> bool:
    status = item.metadata["status"]
    if item.category.prefix == "AC":
        return status == "active"
    if item.category.prefix == "D":
        return status == "accepted"
    if item.category.prefix in {"C", "R"}:
        return status == "active"
    if item.category.prefix == "Q":
        return status in {"bypassed", "dropped"} or "linked_decision" in item.metadata or "references" in item.metadata
    return False


def external_snapshot(root: Path) -> tuple[tuple[str, str, str], ...]:
    snapshot: list[tuple[str, str, str]] = []
    for path in sorted(root.rglob("*"), key=lambda value: value.as_posix()):
        relative = path.relative_to(root)
        if is_os_metadata(relative) or relative.parts[0] in {"shared"} or relative.as_posix() == "feature_spec.md":
            continue
        if path.is_dir():
            snapshot.append(("directory", relative.as_posix(), ""))
        elif path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            snapshot.append(("file", relative.as_posix(), digest))
    return tuple(snapshot)


def validate_close_transition(before_root: str | Path, after_root: str | Path) -> tuple[Workspace, Workspace]:
    before = validate_workspace(before_root)
    if before.closed or before.status != "ready":
        fail("CLOSE source must be an active ready SPEC", before.root / "feature_spec.md")
    if before.open_questions or before.broken_references or before.documentary_gaps:
        fail("CLOSE source still has documentary blockers", before.root / "feature_spec.md")
    after = validate_workspace(after_root)
    if not after.closed:
        fail("CLOSE result must have feature status closed", after.root / "feature_spec.md")

    section_mapping = {
        "Objective": "Objective",
        "Context": "Context",
        "Scope": "Final Scope",
        "Out of Scope": "Out of Scope",
        "Requirements": "Requirements",
        "Business Rules": "Business Rules",
        "Relevant Contracts": "Important Contracts",
    }
    for source_name, final_name in section_mapping.items():
        if normalize(before.sections[source_name]) != normalize(after.sections[final_name]):
            fail(f"CLOSE lost or changed durable section {source_name!r}", after.root / "feature_spec.md")

    expected = {identifier: item for identifier, item in before.items.items() if durable_item(item)}
    missing = sorted(set(expected) - set(after.items))
    if missing:
        fail(f"CLOSE lost durable canonical items: {missing}", after.root / "feature_spec.md")
    for identifier, source_item in expected.items():
        if source_item.preservation_signature() != after.items[identifier].preservation_signature():
            fail(f"CLOSE changed durable content for {identifier}", after.root / "feature_spec.md")

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
    close_parser = subparsers.add_parser("close-transition", help="validate a before/after CLOSE transition")
    close_parser.add_argument("before", type=Path)
    close_parser.add_argument("after", type=Path)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        if args.command == "workspace":
            workspace = validate_workspace(args.root)
            print(f"PASS: {workspace.root} status={workspace.status} ids={len(workspace.items)}")
        else:
            before, after = validate_close_transition(args.before, args.after)
            print(f"PASS: CLOSE {before.root} -> {after.root} preserved durable content and external directories")
    except ValidationError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
