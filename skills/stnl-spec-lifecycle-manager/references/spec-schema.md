# File Purpose Header

```yaml
purpose: Define the sole active and closed document grammar, artifact-specific statuses, and canonical record schemas.
status: not_applicable
read_when: Creating, resuming, validating, selectively reading, or closing a SPEC artifact.
do_not_read_when: Only lifecycle mode selection or workspace ownership is needed.
contains: File headers, H1 and section grammar, derived indexes, category metadata, statuses, and closed layout.
owner: stnl-spec-lifecycle-manager
update_policy: Keep synchronized with templates, parser, readiness gates, and close policy.
```

# SPEC Schema

## File Purpose Header and statuses

Every workspace artifact starts with `# File Purpose Header`, followed by one YAML block containing exactly and in order: `purpose`, `status`, `read_when`, `do_not_read_when`, `contains`, `owner`, and `update_policy`. Do not add competing metadata blocks.

Status values are artifact-specific:

| Artifact | Valid File Purpose Header status |
|---|---|
| Active `feature_spec.md` | `draft`, `blocked`, `ready` |
| Closed `feature_spec.md` | `closed` |
| Materialized requirements, decisions, ACs, constraints, or risks file | `ready` |
| Materialized questions file | `blocked` when an open blocking Q exists; otherwise `ready` |
| Runtime reference or eval index | `not_applicable` |
| Template or worked example | The valid status of the artifact it renders or demonstrates |

Canonical record statuses are separate and defined per category below. A shared-file `ready` status means that category is structurally usable, not that the feature is globally ready.

## Active `feature_spec.md`

After the File Purpose Header, the first semantic content is exactly one non-empty `# <feature name> - Feature SPEC` H1. No preamble, alternate H1, or content before it is allowed. The document then contains exactly once and in order: Objective; Context with `### Facts` then `### Hypotheses`; Scope; Out of Scope; Requirements; Business Rules; Relevant Contracts; Canonical Artifact Index; Blockers; and Selective Reading.

The active feature contains no canonical record block. A heading beginning `### R-*`, `### D-*`, `### AC-*`, `### C-*`, `### RK-*`, or `### Q-*` is duplicate authority and invalid; only the indexed `shared/` file owns that record.

`Requirements` is a sorted derived list of every canonical R heading, written only as `- R-001`. If no requirements file exists, a `draft` or `blocked` feature uses exactly `- Not established.` A `ready` feature requires `shared/requirements.md`, at least one `in_scope` R, and cannot use the sentinel.

The only YAML after the header is the two compact blocks below. The artifact index lists exactly the materialized files in this order and uses `artifacts: {}` when none exist:

```yaml
artifacts:
  requirements: shared/requirements.md
  acceptance_criteria: shared/acceptance-criteria.md
  decisions: shared/decisions.md
  constraints: shared/constraints.md
  risks: shared/risks.md
  questions: shared/questions.md
```

The Blockers block is:

```yaml
blocking_questions: [Q-001, Q-002]
documentary_gaps:
  - Objective description of a material blocking gap.
```

`blocking_questions` is sorted and exactly matches open Q records classified `blocking`. `documentary_gaps` contains only specific material gaps and uses `documentary_gaps: []` when empty. Both prevent `ready`. Broken references are computed validator diagnostics and are never persisted.

Do not persist chat or session history, internal reasoning, executed commands, permanent handoffs, generic repository summaries, derived counts, null paths, materialization or mode-history flags, duplicate status, or redundant traceability.

## Canonical record grammar

Every record starts with `### ID — Title`. After one blank line, metadata is a Markdown list with one `- field: value` per line; `status` is first, category fields follow in their declared order, and `references` is last. One blank line separates metadata from narrative. Arrays use `[ID-001, ID-002]`. Omit absent optional fields; never use `null`. The next `###` or EOF ends the record.

YAML, a repeated `id:`, unsupported metadata, and embedded wrappers are forbidden in canonical records. Template placeholders are limited to `{{FEATURE_NAME}}`, `{{OBJECTIVE}}`, `{{ITEM_TITLE}}`, and `{{CONTENT}}` and cannot remain in a materialized SPEC. Angle-bracket technical syntax such as `Result<User>` is not a placeholder.

Each shared file contains only its File Purpose Header, expected H1, and at least one record of the matching prefix. It permits no preamble, `##` section, wrong-prefix or malformed `###`, appendix, or note.

### Requirements (`R-*`)

Metadata order: required `status`; optional `coverage_justification`; optional `references`. Status is `in_scope`, `out_of_scope`, or `superseded`. Narrative is non-empty requirement authority. `coverage_justification` is allowed only on `in_scope` requirements and must explicitly explain why no observable AC applies; omit it when an active AC verifies the requirement. Requirements never list AC IDs.

### Decisions (`D-*`)

Metadata order: required `status`; optional `references`. Status is `accepted` or `superseded`. Narrative has exactly these non-empty sections in order: `#### Contexto`, `#### Decisão`, `#### Impacto`.

### Acceptance Criteria (`AC-*`)

Metadata order: required `status`; required non-empty `verifies`; optional `blocked_by`; optional `references`. Status is `active`, `superseded`, or `dropped`. `verifies` accepts only existing `R-*`; an active AC in a ready SPEC verifies at least one `in_scope` R. `blocked_by` accepts only open blocking `Q-*` and exists only on active ACs. Narrative is non-empty and is semantically reviewed for concrete, observable, verifiable behavior; scripts validate its grammar and relationships, not quality by keywords.

### Constraints (`C-*`)

Metadata order: required `status`; optional `references`. Status is `active` or `retired`. Narrative has exactly `#### Restrição` and `#### Razão` in order.

### Risks (`RK-*`)

Metadata order: required `status`; required `impact`; optional `references`. Status is `active` or `retired`; impact is `low`, `medium`, or `high`. Narrative has exactly `#### Risco` and `#### Mitigação` in order. An active mitigated risk remains relevant and does not automatically block readiness.

### Questions (`Q-*`)

Metadata order: required `status`; required `classification`; conditional `blocks`; final-state `resolved_by`; conditional `linked_decision`; optional `references`. Status is `open`, `resolved`, `bypassed`, or `dropped`; classification is `blocking`, `non_blocking`, or `irrelevant`. Narrative has exactly `#### Pergunta`, `#### Por que importa`, and `#### Resolução`.

An open blocking Q requires `blocks`, which accepts `AC-*` or `[]` for a global blocker. An open non-blocking Q omits `blocks`. An irrelevant Q cannot be open and is retained only as `dropped`. Final questions have no `blocks` and require `resolved_by: answer|decision|constraint|scope_change`; `linked_decision: D-*` is required exactly with `resolved_by: decision`. Open questions use `Pendente.`; final resolutions are explicit. `dropped` uses `resolved_by: scope_change`, including an explicit determination that the matter is outside the SPEC.

## Closed `feature_spec.md`

After CLOSE, the one file has a `closed` header, the same canonical H1 rule, and sections in this order: Objective; Context; Final Scope; Out of Scope; Requirements; Business Rules; optional Final Acceptance Criteria; optional Durable Decisions; optional Relevant Constraints; optional Relevant Risks; Important Contracts; and Durable Resolved Questions when Q records exist.

`Requirements` contains the exact source R records, not the active derived list. Other canonical sections contain every source record of their type, including superseded, retired, bypassed, or dropped records; omit a category section only when no source record of that type exists. Canonical record blocks retain their active schemas and bytes. The closed file has no YAML beyond the File Purpose Header and no Canonical Artifact Index, Blockers, Selective Reading, or `shared/` residue.
