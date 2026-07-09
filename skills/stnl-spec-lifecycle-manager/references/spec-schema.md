# File Purpose Header

```yaml
purpose: Define operational index and final feature_spec.md schemas.
load_when: Creating the compact index, validating workspace shape, or closing a spec.
do_not_load_when: Only a single shared artifact or slice rule is needed.
contains: Operational feature_spec.md schema, shared artifact shapes, slice fields, lifecycle file shapes, and final close schema.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with references/spec-workspace.md.
```

# SPEC Schema

The living spec is a workspace. Operational `feature_spec.md` is only an index and manifest. The closed spec is a single durable `feature_spec.md`.

## Operational `feature_spec.md`

Use this order:

1. File Purpose Header
2. Spec Metadata
3. Objective
4. Scope
5. Out of Scope
6. Operational State
7. Artifact Index
8. Canonical Paths
9. Blockers
10. Selective Reading Instructions

Do not include full shared artifacts, slice definitions, traceability matrix, QA checklist, or resume notes.

Recommended metadata:

```yaml
spec_id: <feature-slug>
spec_status: draft | ready | blocked
created_from_mode: INIT
last_updated_mode: INIT | RESUME | PLANNING
current_slice: SL-### | null
next_candidate_slice: SL-### | null
open_question_count: <number>
workspace_root: specs/<feature-slug>
```

Recommended artifact index:

```yaml
artifacts:
  acceptance_criteria:
    file: shared/acceptance-criteria.md | null
    count: 0
    materialized: false
  decisions:
    file: shared/decisions.md | null
    count: 0
    materialized: false
  constraints:
    file: shared/constraints.md | null
    count: 0
    materialized: false
  risks:
    file: shared/risks.md | null
    count: 0
    materialized: false
  questions:
    file: shared/questions.md | null
    count: 0
    open_count: 0
    materialized: false
  slices:
    - id: SL-001
      file: slices/SL-001.md
      status: ready
```

When a shared category has no artifacts, set `file: null`, `count: 0`, and `materialized: false`. Do not create an empty shared file.

## Shared Artifact Shape

Every shared file starts with a File Purpose Header and then contains only artifacts of that file's category.

Each artifact requires:

~~~markdown
### AC-001 - <short title>

```yaml
id: AC-001
status: active
...
```
~~~

Use the same pattern for `D-###`, `C-###`, `R-###`, and `Q-###`. Do not mix artifact categories in one shared file.

## Slice File Shape

Each slice file is named `slices/SL-###.md` and must have the same ID in the heading and `id:` field:

~~~markdown
# SL-001 - <slice title>

```yaml
id: SL-001
status: planned | ready | blocked | done | dropped
goal: <one-sentence objective>
scope: <what is included>
out_of_scope: <what is excluded>
linked_acceptance_criteria: [AC-###]
linked_decisions: [D-###]
linked_constraints: [C-###]
linked_risks: [R-###]
linked_questions: [Q-###]
dependencies: [SL-###]
validation_hints:
  - <observable validation hint, not a test case>
context_hints:
  - <file, module, subsystem, API, or domain hint>
slice_readiness:
  status: ready | blocked | needs_reslicing | incomplete
  blockers: [Q-###]
  missing: []
completion_summary: null
```
~~~

Do not repeat the full text of linked artifacts.

## Lifecycle File Shapes

`lifecycle/traceability.md` contains compact ID/path rows only:

| Slice | Slice file | ACs | Constraints | Risks | Decisions | Questions |
|---|---|---|---|---|---|---|
| `SL-001` | `slices/SL-001.md` | `AC-001` | `C-001` | `R-001` | `D-001` | - |

`lifecycle/qa-checklist.md` contains the Spec Quality Gate only:

```yaml
qa_checklist:
  spec_quality_gate:
    status: ready | blocked | incomplete
    blockers: [Q-###]
    checks:
      canonical_ids: pass | fail
      workspace_paths: pass | fail
      open_questions: pass | fail
      acceptance_coverage: pass | fail
      anti_drift_constraints: pass | fail
      risk_coverage: pass | fail
      traceability: pass | fail
      slice_readiness: pass | fail
      validation_hints: pass | fail
```

`lifecycle/resume-notes.md` contains minimal restart state:

```yaml
last_completed_slice: SL-### | null
next_candidate_slice: SL-### | null
blocked_by: [Q-###]
load_next:
  slice: slices/SL-###.md
  shared_ids: [AC-###, C-###, R-###, D-###]
continuity: <one compact note>
```

## Final `feature_spec.md` after `CLOSE`

A closed `feature_spec.md` should use this order:

1. File Purpose Header
2. Objective
3. Final Scope
4. Out of Scope
5. Business Rules
6. Final Acceptance Criteria
7. Durable Decisions
8. Relevant Constraints
9. Relevant Risks
10. Essential Technical Notes

Do not preserve detailed slice execution history, lifecycle checklists, traceability, failed attempts, plans, or resume notes in the final spec.
