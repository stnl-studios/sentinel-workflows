# File Purpose Header

```yaml
purpose: Define deterministic canonical IDs and structural relationship rules.
status: not_applicable
read_when: Creating, resuming, reviewing, selectively reading, or closing canonical SPEC artifacts.
do_not_read_when: A document concern has no canonical item or structural relationship.
contains: ID headings, allocation, internal links, external references, and bidirectional integrity.
owner: stnl-spec-lifecycle-manager
update_policy: Change only through a deliberate canonical-contract decision.
```

# Canonical IDs

| Artifact | Format | File while active |
|---|---|---|
| Questions | `Q-###` | `shared/questions.md` |
| Decisions | `D-###` | `shared/decisions.md` |
| Acceptance criteria | `AC-###` | `shared/acceptance-criteria.md` |
| Risks | `R-###` | `shared/risks.md` |
| Constraints | `C-###` | `shared/constraints.md` |

The generated heading is `### AC-001 — Observable title`, using an em dash. The heading is the sole authority for the ID: never repeat it in an `id:` field or YAML block. Preserve valid IDs exactly; never renumber, reuse, fill gaps, or change casing. Allocate the next ID from the highest suffix of that category in the workspace. Removed, skipped, superseded, dropped, and retired IDs remain reserved.

## Structural relationships

| Field | Origin | Destination |
|---|---|---|
| `blocks` | `Q-*` | `AC-*` |
| `blocked_by` | `AC-*` | `Q-*` |
| `linked_decision` | `Q-*` | `D-*` |
| `references` | Any canonical item | Any canonical ID in the current workspace |

Every structural ID must exist and use the required prefix. Arrays contain no duplicate. `references` cannot point to the item itself. Every `Q-*` → `AC-*` pair in `blocks` must have the inverse `AC-*` → `Q-*` pair in `blocked_by`, and vice versa, regardless of the question's current status.

Only structural metadata fields participate in automatic internal-reference validation. Narrative references such as `ADR-002`, `US-004`, `docs/core/CONTRACTS.md §5`, and `initial-scaffold/D-011` remain external and qualified; a validator must not infer broken local IDs by scanning narrative text.
