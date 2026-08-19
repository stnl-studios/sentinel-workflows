# File Purpose Header

```yaml
purpose: Define deterministic record IDs, monotonic allocation, and single-authority structural relationships.
status: not_applicable
read_when: Creating, resuming, reviewing, selectively reading, or closing canonical SPEC artifacts.
do_not_read_when: A document concern has no canonical item or structural relationship.
contains: Record prefixes, allocation, coverage direction, blocker links, and internal-reference integrity.
owner: stnl-spec-lifecycle-manager
update_policy: Change only through a deliberate canonical-contract decision.
```

# Canonical IDs

| Artifact | Format | File while active |
|---|---|---|
| Requirements | `R-###` | `shared/requirements.md` |
| Acceptance criteria | `AC-###` | `shared/acceptance-criteria.md` |
| Decisions | `D-###` | `shared/decisions.md` |
| Constraints | `C-###` | `shared/constraints.md` |
| Risks | `RK-###` | `shared/risks.md` |
| Questions | `Q-###` | `shared/questions.md` |

The generated heading is `### AC-001 — Observable title`, using an em dash. The heading is the sole authority for ID and type: never repeat it in an `id:` field or YAML block. Preserve every valid ID exactly across RESUME and CLOSE; never physically remove, renumber, reuse, fill gaps, change prefix/type, or change casing. Allocate the next ID as the highest suffix present in that category plus one. Because records remain as documentary tombstones, the materialized set is the high-water mark and no separate ID ledger exists. An inapplicable non-question record stays under its original heading in the canonical terminal state with `retired_reason`; Q records use their existing resolved, bypassed, or dropped forms.

## Structural relationships

| Field | Origin | Destination |
|---|---|---|
| `verifies` | `AC-*` | `R-*` |
| `blocks` | open `Q-*` classified `blocking` | `AC-*` |
| `blocked_by` | active `AC-*` | open blocking `Q-*` |
| `linked_decision` | `Q-*` | `D-*` |
| `references` | Any canonical item | Any canonical ID in the current workspace |

Every structural target must exist and use the required prefix. Arrays contain no duplicate. `references` cannot point to the item itself. Every open blocking `Q-*` → `AC-*` pair in `blocks` has the exact inverse `AC-*` → `Q-*` pair in `blocked_by`, and vice versa.

Requirement-to-criterion traceability has one direction only: AC `verifies` lists requirements. A requirement never lists AC IDs. A requirement with no verifying active AC may instead carry its own formal `coverage_justification`; that exception is not a second traceability direction. Global readiness rejects an active AC that verifies no existing in-scope requirement and an in-scope requirement with neither active coverage nor a valid justification.

Only structural metadata fields participate in automatic internal-reference validation. Narrative references such as `ADR-002`, `US-004`, `docs/core/CONTRACTS.md §5`, and `initial-scaffold/D-011` remain external and qualified; a validator must not infer broken local IDs by scanning narrative text.
