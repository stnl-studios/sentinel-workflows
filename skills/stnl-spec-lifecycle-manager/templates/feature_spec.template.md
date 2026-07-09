# File Purpose Header

```yaml
purpose: Template for the operational feature_spec.md index.
status: draft
read_when: Starting INIT, RESUME, PLANNING, or discovering the next slice.
do_not_read_when: A role already has the current slice package and does not need workspace discovery.
contains: Compact metadata, objective, scope, artifact index, canonical paths, blockers, and selective-reading instructions.
owner: stnl-spec-lifecycle-manager
update_policy: Developer or stnl-spec-lifecycle-manager may update index metadata; CLOSE replaces this with the final spec.
```

# <Feature Name> - Feature Spec Index

## Spec Metadata

```yaml
spec_id: <feature-slug>
workspace_root: specs/<feature-slug>
spec_status: draft
created_from_mode: INIT
last_updated_mode: INIT
current_slice: null
next_candidate_slice: null
open_question_count: 0
```

## Objective

<One concise paragraph describing what changes and why it matters.>

## Scope

- <Included behavior, system area, user flow, or technical boundary.>

## Out of Scope

- <Explicit exclusions that prevent drift.>

## Operational State

```yaml
readiness: draft | ready | blocked
blockers: []
last_completed_slice: null
next_candidate_slice: null
```

## Artifact Index

```yaml
artifacts:
  acceptance_criteria:
    file: null
    count: 0
    materialized: false
  decisions:
    file: null
    count: 0
    materialized: false
  constraints:
    file: null
    count: 0
    materialized: false
  risks:
    file: null
    count: 0
    materialized: false
  questions:
    file: null
    count: 0
    open_count: 0
    materialized: false
  slices: []
```

## Canonical Paths

```yaml
paths:
  feature_index: feature_spec.md
  shared:
    acceptance_criteria: shared/acceptance-criteria.md
    decisions: shared/decisions.md
    constraints: shared/constraints.md
    risks: shared/risks.md
    questions: shared/questions.md
  slices_dir: slices/
  lifecycle:
    traceability: lifecycle/traceability.md
    qa_checklist: lifecycle/qa-checklist.md
    resume_notes: lifecycle/resume-notes.md
```

## Blockers

```yaml
open_questions: []
broken_references: []
readiness_blockers: []
```

## Selective Reading Instructions

1. Read this index first.
2. Read `lifecycle/resume-notes.md` only when resuming or checking continuity.
3. Read the `next_candidate_slice` file.
4. Load only linked artifact blocks from materialized `shared/*.md` files.
5. Load lifecycle files only when the MODE or role requires them.
