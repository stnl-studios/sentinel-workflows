# File Purpose Header

```yaml
purpose: Define active and closed SPEC structures plus canonical Markdown item schemas.
status: not_applicable
read_when: Creating, resuming, validating, selectively reading, or closing a SPEC artifact.
do_not_read_when: Only lifecycle mode selection or workspace ownership is needed.
contains: Feature sections, compact YAML indexes, item metadata, statuses, narrative sections, and final structure.
owner: stnl-spec-lifecycle-manager
update_policy: Keep synchronized with templates, parser, readiness gates, and close policy.
```

# SPEC Schema

## Active `feature_spec.md`

Use real Markdown sections for Objective; Context with `### Facts` and `### Hypotheses`; Scope; Out of Scope; Requirements; Business Rules; Relevant Contracts; Canonical Artifact Index; Blockers; and Selective Reading. Do not duplicate full canonical items in this file.

The only YAML beyond the File Purpose Header is compact file-level state:

```yaml
artifacts: {}
```

When categories are materialized, list only the files that exist:

```yaml
artifacts:
  acceptance_criteria: shared/acceptance-criteria.md
  questions: shared/questions.md
```

Include only materialized categories, in the order shown. Do not add counts, materialization flags, null paths, workspace paths, mode history, or duplicate status fields.

```yaml
open_questions: [Q-001, Q-002]
broken_references: []
documentary_gaps:
  - Objective description of a material blocking gap.
```

`open_questions` is a sorted derived index that exactly matches open `Q-*` items. `documentary_gaps` contains only material gaps; every listed gap blocks `ready`. `broken_references` is empty in a structurally valid or ready workspace.

## Canonical item grammar

Every item starts with `### ID — Title`. After one blank line, metadata is a Markdown list with one `- field: value` per line; `status` is first, category fields follow, and `references` is last. A blank line separates metadata from narrative content. Arrays use `[ID-001, ID-002]`. Omit absent optional fields; never use `null`. The next `###` heading or EOF ends the item.

YAML and duplicate `id:` fields are forbidden inside canonical items. Template placeholders use only the explicit `{{FEATURE_NAME}}`, `{{OBJECTIVE}}`, `{{ITEM_TITLE}}`, and `{{CONTENT}}` syntax and must not remain in materialized SPECs. Angle-bracket technical syntax such as `Result<User>`, `Promise<Result<T>>`, or HTML tags is not placeholder syntax.

Shared category files contain only the File Purpose Header, the expected root heading, and canonical items for that category. They do not permit preambles, `##` sections, invalid `###` headings, appendices, notes, or unknown item subsections.

### Acceptance Criteria

Metadata order: required `status`; optional `blocked_by`; optional `references`. Status is `active`, `superseded`, or `dropped`. `blocked_by` accepts only `Q-*` questions whose status is currently `open`; `references` accepts existing internal IDs. An in-scope criterion stays `active` while blocked; blocking is represented only by `blocked_by`, never `status: blocked` or duplicate narrative phrases. The structural parser verifies that narrative is present, non-empty, placeholder-free, and has a reasonable minimum size. Whether the criterion is observable and verifiable is a semantic readiness finding during INIT, RESUME, or PLANNING, not a deterministic keyword check.

### Decisions

Metadata order: required `status`; optional `references`. Status is `accepted` or `superseded`. Narrative has exactly these non-empty sections in order: `#### Contexto`, `#### Decisão`, `#### Impacto`.

### Constraints

Metadata order: required `status`; optional `references`. Status is `active` or `retired`. Narrative has exactly `#### Restrição` and `#### Razão` in order.

### Risks

Metadata order: required `status`; required `impact`; optional `references`. Status is `active` or `retired`; impact is `low`, `medium`, or `high`. Narrative has exactly `#### Risco` and `#### Mitigação` in order. `active` means materially relevant even when mitigated or accepted; it does not automatically block readiness. `retired` means the risk no longer applies.

### Questions

Metadata order: required `status`; `blocks` only when `status: open`; final-state `resolved_by` when applicable; conditional `linked_decision`; optional `references` last. Status is `open`, `resolved`, `bypassed`, or `dropped`. `blocks` accepts only `AC-*` and may be `[]` for a global documentary block. Non-open questions must not contain `blocks`; historical context belongs in `linked_decision`, `references`, or the resolution narrative. Narrative has exactly `#### Pergunta`, `#### Por que importa`, and `#### Resolução`.

Use `resolved_by: answer | decision | constraint | scope_change` only in final states. A final-state item records `resolved_by`; `linked_decision` is required exactly when `resolved_by: decision` and points to an existing `D-*`. `open` uses `Pendente.` as resolution and has `blocks` but no final-state field. `resolved` requires an explicit answer, `bypassed` an explicit justification, and `dropped` an explicit scope change or removal; `dropped` uses `resolved_by: scope_change`.

## Closed `feature_spec.md`

After CLOSE, the one file contains Objective; Context; Final Scope; Out of Scope; Requirements; Business Rules; Final Acceptance Criteria; Durable Decisions; Relevant Constraints; Relevant Risks; Important Contracts; and Durable Resolved Questions when relevant. Canonical items retain the same heading, metadata, and narrative schemas used while active, except active blockers are absent: closed ACs do not retain `blocked_by`, and final questions do not retain `blocks`. Sections with no durable item may be omitted, but required durable content may not be collapsed or lost.
