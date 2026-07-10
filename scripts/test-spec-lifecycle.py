#!/usr/bin/env python3
"""Executable fixtures and eval assertions for the lifecycle SPEC contract."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL_ROOT = ROOT / "skills/stnl-spec-lifecycle-manager"
TEMPLATE_ROOT = SKILL_ROOT / "templates"
CASES_PATH = SKILL_ROOT / "evals/cases.json"
sys.path.insert(0, str(ROOT / "scripts"))

from validate_spec_lifecycle import (  # noqa: E402
    CATEGORIES,
    Item,
    ValidationError,
    Workspace,
    validate_close_transition,
    validate_workspace,
)


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def template_header(name: str, status: str) -> str:
    text = (TEMPLATE_ROOT / name).read_text(encoding="utf-8")
    match = re.match(r"# File Purpose Header\n\n```yaml\n.*?```\n\n", text, re.DOTALL)
    expect(match is not None, f"template header is malformed: {name}")
    header = match.group(0)
    header, replacements = re.subn(r"(?m)^status: \S+$", f"status: {status}", header, count=1)
    expect(replacements == 1, f"template header status is missing: {name}")
    return header


def render_feature(status: str, artifact_keys: list[str], open_questions: list[str], broken: list[str] | None = None) -> str:
    paths = {category.key: f"shared/{category.filename}" for category in CATEGORIES}
    artifact_lines = "\n".join(f"  {key}: {paths[key]}" for key in artifact_keys)
    open_array = "[" + ", ".join(open_questions) + "]"
    broken_array = "[" + ", ".join(broken or []) + "]"
    return template_header("feature_spec.template.md", status) + f"""# Fixture Feature - Feature SPEC

## Objective

Provide deterministic invitation expiration behavior.

## Context

### Facts

- Invitations already contain an UTC expiration timestamp.

### Hypotheses

- None identified.

## Scope

- Reject acceptance after the stored expiration timestamp.

## Out of Scope

- Changing invitation delivery channels.

## Requirements

- Expiration is evaluated consistently for every client.

## Business Rules

- The service clock is the time authority.

## Relevant Contracts

- `docs/core/CONTRACTS.md §5` defines the HTTP error envelope.

## Canonical Artifact Index

```yaml
artifacts:
{artifact_lines}
```

## Blockers

```yaml
open_questions: {open_array}
broken_references: {broken_array}
documentary_gaps: []
```

## Selective Reading

1. Read this header and artifact index.
2. Map the requested ID to one category file.
3. Read the exact item through the next `###` heading or EOF.
4. Follow only necessary structural metadata links.
"""


def acceptance_item(*, references: bool = True, blocked: bool = False, narrative: str | None = None, status: str = "active") -> str:
    blocked_line = "- blocked_by: [Q-001]\n" if blocked else ""
    reference_line = "- references: [D-001, C-001, R-001]\n" if references else ""
    body = narrative or "A sessão é restaurada ao reabrir o aplicativo com credenciais válidas, mantendo o usuário autenticado sem repetir o login."
    return f"""### AC-001 — Expired invitation is rejected

- status: {status}
{blocked_line}\
{reference_line}
{body} The qualified external origin `initial-scaffold/D-011` is narrative only.
"""


def decision_item() -> str:
    return """### D-001 — Service clock is authoritative

- status: accepted
- references: [C-001]

#### Contexto

Client clocks can diverge and cannot produce a consistent expiration result.

#### Decisão

The service compares `expires_at` with its own UTC clock.

#### Impacto

All clients observe one deterministic expiration decision.
"""


def simple_decision_item() -> str:
    return """### D-001 — Service clock is authoritative

- status: accepted

#### Contexto

Client clocks can diverge across invitation acceptance attempts.

#### Decisão

The service clock is the single UTC time authority.

#### Impacto

Invitation expiration is deterministic for every client.
"""


def constraint_item() -> str:
    return """### C-001 — Public error envelope remains stable

- status: active
- references: [D-001]

#### Restrição

Expired invitations use the existing public HTTP error envelope.

#### Razão

Clients already depend on that response contract.
"""


def risk_item() -> str:
    return """### R-001 — Clock drift near expiration boundary

- status: active
- impact: medium
- references: [C-001, AC-001]

#### Risco

Clock drift between service nodes can change the result near the expiration boundary.

#### Mitigação

Synchronize nodes, monitor drift, and retain the risk as active while it remains material.
"""


def question_item(status: str) -> str:
    if status == "open":
        metadata = "- status: open\n- blocks: [AC-001]"
        resolution = "Pendente."
    else:
        metadata = "- status: resolved\n- resolved_by: decision\n- linked_decision: D-001"
        resolution = "D-001 explicitly establishes the service UTC clock as authority."
    return f"""### Q-001 — Which clock determines expiration

{metadata}

#### Pergunta

Which clock determines whether an invitation is expired?

#### Por que importa

The answer changes the result observed by AC-001.

#### Resolução

{resolution}
"""


def shared_document(template_name: str, status: str, root_heading: str, item: str) -> str:
    return template_header(template_name, status) + f"# {root_heading}\n\n{item}"


def write_full_workspace(root: Path, status: str) -> None:
    question_status = "open" if status == "blocked" else "resolved"
    artifact_keys = [category.key for category in CATEGORIES]
    write(root / "feature_spec.md", render_feature(status, artifact_keys, ["Q-001"] if status == "blocked" else []))
    blocked = status == "blocked"
    write(
        root / "shared/acceptance-criteria.md",
        shared_document("shared-acceptance-criteria.template.md", "ready", "Acceptance Criteria", acceptance_item(blocked=blocked)),
    )
    write(
        root / "shared/decisions.md",
        shared_document("shared-decisions.template.md", "ready", "Decisions", decision_item()),
    )
    write(
        root / "shared/constraints.md",
        shared_document("shared-constraints.template.md", "ready", "Constraints", constraint_item()),
    )
    write(
        root / "shared/risks.md",
        shared_document("shared-risks.template.md", "ready", "Risks", risk_item()),
    )
    write(
        root / "shared/questions.md",
        shared_document(
            "shared-questions.template.md",
            "blocked" if status == "blocked" else "ready",
            "Questions",
            question_item(question_status),
        ),
    )


def write_decisionless_blocked(root: Path) -> None:
    write(root / "feature_spec.md", render_feature("blocked", ["acceptance_criteria", "questions"], ["Q-001"]))
    write(
        root / "shared/acceptance-criteria.md",
        shared_document("shared-acceptance-criteria.template.md", "ready", "Acceptance Criteria", acceptance_item(references=False, blocked=True)),
    )
    write(
        root / "shared/questions.md",
        shared_document("shared-questions.template.md", "blocked", "Questions", question_item("open")),
    )


def render_metadata(item: Item) -> str:
    lines: list[str] = []
    for field in item.category.fields:
        if field not in item.metadata:
            continue
        value = item.metadata[field]
        if isinstance(value, tuple):
            rendered = "[" + ", ".join(value) + "]"
        else:
            rendered = value
        lines.append(f"- {field}: {rendered}")
    return "\n".join(lines)


def render_item(item: Item) -> str:
    return f"### {item.identifier} — {item.title}\n\n{render_metadata(item)}\n\n{item.narrative}\n"


def render_closed(source: Workspace) -> str:
    by_prefix: dict[str, list[Item]] = {prefix: [] for prefix in ["AC", "D", "C", "R", "Q"]}
    for item in source.items.values():
        by_prefix[item.category.prefix].append(item)
    for values in by_prefix.values():
        values.sort(key=lambda item: item.identifier)

    chunks = [
        template_header("closed-feature_spec.template.md", "closed"),
        "# Fixture Feature - Feature SPEC\n\n",
        f"## Objective\n\n{source.sections['Objective']}\n\n",
        f"## Context\n\n{source.sections['Context']}\n\n",
        f"## Final Scope\n\n{source.sections['Scope']}\n\n",
        f"## Out of Scope\n\n{source.sections['Out of Scope']}\n\n",
        f"## Requirements\n\n{source.sections['Requirements']}\n\n",
        f"## Business Rules\n\n{source.sections['Business Rules']}\n\n",
    ]
    closed_sections = [
        ("Final Acceptance Criteria", "AC"),
        ("Durable Decisions", "D"),
        ("Relevant Constraints", "C"),
        ("Relevant Risks", "R"),
    ]
    for heading, prefix in closed_sections:
        if by_prefix[prefix]:
            chunks.append(f"## {heading}\n\n")
            chunks.extend(render_item(item) + "\n" for item in by_prefix[prefix])
    chunks.append(f"## Important Contracts\n\n{source.sections['Relevant Contracts']}\n\n")
    if by_prefix["Q"]:
        chunks.append("## Durable Resolved Questions\n\n")
        chunks.extend(render_item(item) + "\n" for item in by_prefix["Q"])
    return "".join(chunks).rstrip() + "\n"


def file_snapshot(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def changed_paths(before: dict[str, str], after: dict[str, str]) -> set[str]:
    return {path for path in set(before) | set(after) if before.get(path) != after.get(path)}


def allowed(path: str, allowed_changes: list[str]) -> bool:
    return any(path == entry or (entry.endswith("/") and path.startswith(entry)) for entry in allowed_changes)


def assert_changes_are_allowed(changes: set[str], allowed_changes: list[str], case_id: str) -> None:
    unexpected = sorted(path for path in changes if not allowed(path, allowed_changes))
    expect(not unexpected, f"{case_id}: unexpected changed paths: {unexpected}")


def mutate_workspace(root: Path, fixture: str) -> None:
    if fixture in {
        "ready",
        "blocked",
        "decisionless_blocked",
        "external_reference",
        "active_risk",
        "ready_with_execution",
        "valid_non_heuristic_ac",
        "technical_result_user",
        "technical_promise_result",
        "technical_html",
        "empty_artifact_index",
        "ready_missing_ac_file",
        "ready_no_ac_index",
        "unindexed_ac_file",
        "blocked_without_ac",
        "open_question_reciprocal",
    }:
        return
    if fixture == "empty_ac":
        path = root / "shared/acceptance-criteria.md"
        write(path, template_header("shared-acceptance-criteria.template.md", "ready") + "# Acceptance Criteria\n\n")
    elif fixture == "no_active_ac":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("- status: active", "- status: superseded", 1))
    elif fixture == "only_dropped_ac":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("- status: active", "- status: dropped", 1))
    elif fixture == "ready_ac_blocked":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("- status: active\n", "- status: active\n- blocked_by: [Q-001]\n", 1))
    elif fixture == "empty_ac_narrative":
        path = root / "shared/acceptance-criteria.md"
        text = path.read_text(encoding="utf-8")
        text = re.sub(r"\n\nA sessão.*narrative only\.\n", "\n\n\n", text, count=1)
        write(path, text)
    elif fixture == "placeholder_real":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("A sessão", "{{CONTENT}} A sessão", 1))
    elif fixture == "preamble_before_item":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("# Acceptance Criteria\n\n", "# Acceptance Criteria\n\nArbitrary preamble.\n\n", 1))
    elif fixture == "notes_after_item":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8") + "\n## Notes\n\nArbitrary notes.\n")
    elif fixture == "wrong_root_heading":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("# Acceptance Criteria", "# Criteria", 1))
    elif fixture == "multiple_root_headings":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("# Acceptance Criteria\n\n", "# Acceptance Criteria\n\n# Acceptance Criteria\n\n", 1))
    elif fixture == "unknown_item_section":
        path = root / "shared/decisions.md"
        write(path, path.read_text(encoding="utf-8").replace("#### Impacto\n\n", "#### Unknown\n\nUnexpected section.\n\n#### Impacto\n\n", 1))
    elif fixture == "invalid_h3_heading":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("### AC-001 —", "### Criterion —", 1))
    elif fixture == "loose_content_after_item":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8") + "\n### Appendix\n\nLoose content.\n")
    elif fixture == "open_question_without_blocks":
        write_full_workspace(root, "blocked")
        path = root / "shared/questions.md"
        write(path, path.read_text(encoding="utf-8").replace("- blocks: [AC-001]\n", "", 1))
    elif fixture == "resolved_question_with_blocks":
        path = root / "shared/questions.md"
        write(path, path.read_text(encoding="utf-8").replace("- status: resolved\n", "- status: resolved\n- blocks: [AC-001]\n", 1))
    elif fixture == "blocked_by_resolved_question":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("- status: active\n", "- status: active\n- blocked_by: [Q-001]\n", 1))
    elif fixture == "missing_internal":
        risk = root / "shared/risks.md"
        write(risk, risk.read_text(encoding="utf-8").replace("[C-001, AC-001]", "[C-001, AC-999]"))
        feature = root / "feature_spec.md"
        write(feature, feature.read_text(encoding="utf-8").replace("broken_references: []", "broken_references: [AC-999]"))
    elif fixture == "divergent_links":
        path = root / "shared/acceptance-criteria.md"
        write_full_workspace(root, "blocked")
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("- blocked_by: [Q-001]\n", ""))
    elif fixture == "item_yaml":
        path = root / "shared/acceptance-criteria.md"
        text = path.read_text(encoding="utf-8")
        text = text.replace("A sessão", "```yaml\nstatus: active\n```\n\nA sessão", 1)
        write(path, text)
    elif fixture == "body_id":
        path = root / "shared/acceptance-criteria.md"
        text = path.read_text(encoding="utf-8").replace("A sessão", "id: AC-001\n\nA sessão", 1)
        write(path, text)
    elif fixture == "duplicate_id":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8") + "\n" + acceptance_item())
    elif fixture == "wrong_prefix":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("### AC-001 —", "### D-001 —", 1))
    elif fixture == "missing_metadata":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("- status: active\n", "", 1))
    elif fixture == "invalid_status":
        path = root / "shared/risks.md"
        write(path, path.read_text(encoding="utf-8").replace("- status: active", "- status: open", 1))
    elif fixture == "stale_open_index":
        path = root / "feature_spec.md"
        write(path, path.read_text(encoding="utf-8").replace("open_questions: [Q-001]", "open_questions: []", 1))
    else:
        raise AssertionError(f"unknown fixture mutation: {fixture}")


def workspace_fixture(root: Path, fixture: str) -> None:
    if fixture in {"blocked", "stale_open_index", "open_question_reciprocal"}:
        write_full_workspace(root, "blocked")
    elif fixture == "decisionless_blocked":
        write_decisionless_blocked(root)
    elif fixture == "ready_missing_ac_file":
        write_full_workspace(root, "ready")
        (root / "shared/acceptance-criteria.md").unlink()
    elif fixture == "ready_no_ac_index":
        write(root / "feature_spec.md", render_feature("ready", [], []))
    elif fixture == "empty_artifact_index":
        write(root / "feature_spec.md", render_feature("draft", [], []))
    elif fixture == "blocked_without_ac":
        write(root / "feature_spec.md", render_feature("blocked", ["questions"], ["Q-001"]))
        question = question_item("open").replace("- blocks: [AC-001]", "- blocks: []", 1)
        write(
            root / "shared/questions.md",
            shared_document("shared-questions.template.md", "blocked", "Questions", question),
        )
    elif fixture == "unindexed_ac_file":
        write(root / "feature_spec.md", render_feature("draft", [], []))
        write(
            root / "shared/acceptance-criteria.md",
            shared_document("shared-acceptance-criteria.template.md", "ready", "Acceptance Criteria", acceptance_item()),
        )
    else:
        write_full_workspace(root, "ready")
    if fixture == "ready_with_execution":
        write(root / "execution/retained-record.txt", "external execution state\n")
    elif fixture == "technical_result_user":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("A sessão", "O adapter retorna `Repository<Result<User>>` e mantém", 1))
    elif fixture == "technical_promise_result":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("A sessão", "Chamadas subsequentes funcionam com `Promise<Result<T>>` e", 1))
    elif fixture == "technical_html":
        path = root / "shared/acceptance-criteria.md"
        write(path, path.read_text(encoding="utf-8").replace("A sessão", "O resumo mantém a tag `<strong>` renderizada e", 1))
    mutate_workspace(root, fixture)


def assert_workspace(case: dict[str, object], workspace: Workspace, result_root: Path) -> None:
    expect(workspace.status == case["expected_status"], f"{case['id']}: wrong status {workspace.status}")
    expected_ids = set(case["expected_ids"])
    expect(set(workspace.items) == expected_ids, f"{case['id']}: wrong IDs {sorted(workspace.items)}")
    for expression, expected in case["expected_links"].items():
        identifier, field = expression.split(".", 1)
        actual = workspace.items[identifier].metadata.get(field)
        if isinstance(actual, tuple):
            actual = list(actual)
        expect(actual == expected, f"{case['id']}: {expression}={actual!r}, expected {expected!r}")
    for relative in case["expected_files"]:
        expect((result_root / relative).exists(), f"{case['id']}: expected file is missing: {relative}")
    for forbidden in ("plan.md", "tasks.md", "plans", "tasks"):
        expect(not (result_root / forbidden).exists(), f"{case['id']}: operational artifact exists: {forbidden}")


def run_resume_resolve(case: dict[str, object], base: Path) -> tuple[Workspace, Path, set[str]]:
    before = base / "before"
    after = base / "after"
    write_full_workspace(before, "blocked")
    validate_workspace(before)
    shutil.copytree(before, after)
    before_snapshot = file_snapshot(before)
    feature = after / "feature_spec.md"
    text = feature.read_text(encoding="utf-8").replace("status: blocked", "status: ready", 1)
    write(feature, text.replace("open_questions: [Q-001]", "open_questions: []", 1))
    questions = after / "shared/questions.md"
    write(
        questions,
        shared_document("shared-questions.template.md", "ready", "Questions", question_item("resolved")),
    )
    ac = after / "shared/acceptance-criteria.md"
    write(ac, ac.read_text(encoding="utf-8").replace("- blocked_by: [Q-001]\n", "", 1))
    workspace = validate_workspace(after)
    changes = changed_paths(before_snapshot, file_snapshot(after))
    assert_changes_are_allowed(changes, case["allowed_changes"], str(case["id"]))
    return workspace, after, changes


def run_resume_decision(case: dict[str, object], base: Path) -> tuple[Workspace, Path, set[str]]:
    before = base / "before"
    after = base / "after"
    write_decisionless_blocked(before)
    validate_workspace(before)
    shutil.copytree(before, after)
    before_snapshot = file_snapshot(before)
    write(after / "feature_spec.md", render_feature("ready", ["acceptance_criteria", "decisions", "questions"], []))
    ac = acceptance_item(references=False).replace(
        "\nA sessão", "- references: [D-001]\n\nA sessão", 1
    )
    write(
        after / "shared/acceptance-criteria.md",
        shared_document("shared-acceptance-criteria.template.md", "ready", "Acceptance Criteria", ac),
    )
    write(
        after / "shared/decisions.md",
        shared_document("shared-decisions.template.md", "ready", "Decisions", simple_decision_item()),
    )
    write(
        after / "shared/questions.md",
        shared_document("shared-questions.template.md", "ready", "Questions", question_item("resolved")),
    )
    workspace = validate_workspace(after)
    changes = changed_paths(before_snapshot, file_snapshot(after))
    assert_changes_are_allowed(changes, case["allowed_changes"], str(case["id"]))
    return workspace, after, changes


def build_close_pair(base: Path, status: str) -> tuple[Path, Path]:
    before = base / "before"
    after = base / "after"
    write_full_workspace(before, status)
    write(before / "execution/retained-record.txt", "external execution state\n")
    source = validate_workspace(before)
    shutil.copytree(before, after)
    write(after / "feature_spec.md", render_closed(source))
    shutil.rmtree(after / "shared")
    return before, after


def execute(case: dict[str, object], base: Path) -> tuple[Workspace | None, Path, str | None]:
    runner = case["runner"]
    if runner == "resume_resolve":
        workspace, result, _ = run_resume_resolve(case, base)
        return workspace, result, None
    if runner == "resume_decision":
        workspace, result, _ = run_resume_decision(case, base)
        return workspace, result, None
    if runner in {"close_valid", "close_loss", "close_execution_mutation", "close_blocked"}:
        before, after = build_close_pair(base, "blocked" if runner == "close_blocked" else "ready")
        before_snapshot = file_snapshot(before)
        if runner == "close_loss":
            feature = after / "feature_spec.md"
            write(feature, feature.read_text(encoding="utf-8").replace(
                "All clients observe one deterministic expiration decision.",
                "Clients may observe a changed expiration decision.",
                1,
            ))
        elif runner == "close_execution_mutation":
            write(after / "execution/retained-record.txt", "mutated external execution state\n")
        _, workspace = validate_close_transition(before, after)
        changes = changed_paths(before_snapshot, file_snapshot(after))
        assert_changes_are_allowed(changes, case["allowed_changes"], str(case["id"]))
        return workspace, after, None

    root = base / "workspace"
    workspace_fixture(root, str(case["fixture"]))
    before = file_snapshot(root)
    workspace = validate_workspace(root)
    after = file_snapshot(root)
    if runner == "planning_read_only":
        expect(before == after, f"{case['id']}: PLANNING changed the workspace")
    else:
        expect(before == after, f"{case['id']}: validator changed the workspace")
    return workspace, root, None


def validate_template_contract() -> None:
    shared_templates = sorted(TEMPLATE_ROOT.glob("shared-*.template.md"))
    expect(len(shared_templates) == 5, "expected five shared canonical templates")
    for path in shared_templates:
        text = path.read_text(encoding="utf-8")
        after_header = re.sub(r"\A# File Purpose Header\n\n```yaml\n.*?```\n\n", "", text, count=1, flags=re.DOTALL)
        expect("```yaml" not in after_header and "```markdown" not in after_header, f"item wrapper remains: {path}")
        expect(re.search(r"^### (?:AC|D|C|R|Q)-\d{3} — ", after_header, re.MULTILINE) is not None, f"canonical heading missing: {path}")
        expect(re.search(r"(?m)^id:\s*(?:AC|D|C|R|Q)-", after_header) is None, f"duplicate ID field remains: {path}")
        expect("null" not in after_header.casefold(), f"null optional metadata remains: {path}")
        expect("{{CONTENT}}" in after_header or "{{ITEM_TITLE}}" in after_header, f"explicit template placeholders missing: {path}")
    feature = (TEMPLATE_ROOT / "feature_spec.template.md").read_text(encoding="utf-8")
    expect(feature.count("```yaml") == 3, "active feature template must use YAML only for header, index, and blockers")
    expect("artifacts: {}" in feature, "active feature template must not pre-list unmaterialized categories")
    closed = (TEMPLATE_ROOT / "closed-feature_spec.template.md").read_text(encoding="utf-8")
    expect(closed.count("```yaml") == 1, "closed template must use YAML only for its File Purpose Header")
    expect("blocked_by:" not in closed and "blocks:" not in closed, "closed template must not preserve active blockers")
    expect("### Facts" in feature and "### Hypotheses" in feature, "active template lacks real Context headings")
    expect("### Facts" in closed and "### Hypotheses" in closed, "closed template cannot preserve Context structure")

    with tempfile.TemporaryDirectory(prefix="stnl-real-templates-") as tmp:
        workspace = Path(tmp)
        concrete = "Concrete durable fixture content with enough structural detail."
        instantiated_feature = re.sub(r"{{(?:FEATURE_NAME|OBJECTIVE|ITEM_TITLE|CONTENT)}}", concrete, feature)
        write(workspace / "feature_spec.md", instantiated_feature)
        validated = validate_workspace(workspace)
        expect(validated.status == "draft", "instantiated real templates do not form a valid draft workspace")
        expect(set(validated.items) == set(), "empty artifact index must not materialize categories")
        closed_workspace = workspace / "closed-template"
        instantiated_closed = re.sub(r"{{(?:FEATURE_NAME|OBJECTIVE|ITEM_TITLE|CONTENT)}}", concrete, closed)
        write(closed_workspace / "feature_spec.md", instantiated_closed)
        validated_closed = validate_workspace(closed_workspace)
        expect(validated_closed.status == "closed", "instantiated closed template is structurally invalid")


def main() -> int:
    validate_template_contract()
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    required = {
        "id",
        "operation",
        "runner",
        "fixture",
        "input_files",
        "expected_files",
        "allowed_changes",
        "expected_valid",
        "expected_status",
        "expected_ids",
        "expected_links",
        "assertions",
    }
    seen: set[str] = set()
    passed = 0
    for case in cases:
        missing = required - set(case)
        expect(not missing, f"eval case lacks fields {sorted(missing)}: {case.get('id')}")
        expect(case["id"] not in seen, f"duplicate eval ID: {case['id']}")
        if case["operation"] == "INIT":
            uncovered = [path for path in case["expected_files"] if not allowed(path, case["allowed_changes"])]
            expect(not uncovered, f"{case['id']}: INIT expected files exceed allowed changes: {uncovered}")
        seen.add(case["id"])
        with tempfile.TemporaryDirectory(prefix=f"stnl-{case['id']}-") as tmp:
            try:
                workspace, result_root, _ = execute(case, Path(tmp))
            except ValidationError as exc:
                if case["expected_valid"]:
                    raise AssertionError(f"{case['id']}: expected valid, got {exc}") from exc
                expected_error = str(case.get("expected_error", ""))
                expect(expected_error in str(exc), f"{case['id']}: wrong failure: {exc}")
            else:
                expect(case["expected_valid"], f"{case['id']}: invalid fixture was accepted")
                expect(workspace is not None, f"{case['id']}: valid case returned no workspace")
                assert_workspace(case, workspace, result_root)
            passed += 1

    required_case_ids = {
        "init-ready",
        "init-blocked",
        "resume-resolves-question",
        "resume-creates-durable-decision",
        "planning-read-only",
        "ac-session-restored-valid",
        "ac-empty-rejected",
        "ac-placeholder-rejected",
        "ready-no-active-ac",
        "ready-no-ac-index-rejected",
        "blocked-without-ac-valid",
        "result-user-accepted",
        "preamble-before-item-rejected",
        "resolved-question-with-blocks-rejected",
        "blocked-by-resolved-question-rejected",
        "empty-artifact-index-valid",
        "missing-internal-id",
        "qualified-external-id",
        "inverse-link-divergence",
        "active-mitigated-risk",
        "close-complete",
        "close-blocked",
        "close-preserves-execution",
        "item-yaml-forbidden",
        "body-id-forbidden",
    }
    expect(required_case_ids <= seen, f"missing required executable evals: {sorted(required_case_ids - seen)}")
    print(f"PASS: {passed} executable lifecycle eval cases")
    print("PASS: canonical Markdown templates and compact YAML boundaries")
    print("PASS: positive, negative, CLOSE preservation, and execution-boundary fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
