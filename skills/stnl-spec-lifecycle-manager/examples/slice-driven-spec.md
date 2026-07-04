# File Purpose Header

```yaml
purpose: Larger example showing multiple slices and compact traceability.
load_when: The agent needs a concrete multi-slice example.
do_not_load_when: Minimal example is sufficient.
contains: Multi-slice spec with questions resolved, decisions, risks, constraints, and readiness.
owner: stnl-spec-lifecycle-manager
update_policy: Keep concise and aligned with template.
```

# Bulk Import Status — Feature Spec

```yaml
purpose: Living feature specification for bulk import status tracking.
status: ready
mode_last_updated: PLANNING
canonical_artifacts: [Q, D, AC, SL, R, C]
read_when: Planning, resuming, or validating import status work.
do_not_read_when: Executing a single slice; use the slice context package instead.
```

## Spec Metadata

```yaml
spec_id: bulk-import-status
spec_status: ready
created_from_mode: INIT
last_updated_mode: PLANNING
current_slice: null
next_candidate_slice: SL-001
open_question_count: 0
```

## Objective

Expose reliable status tracking for bulk imports so users can understand whether an import is pending, processing, completed, or failed.

## Scope

- Persist import status transitions.
- Expose import status through an existing or new status query path.
- Preserve compatibility with the current import submission flow.

## Out of Scope

- No new import file format.
- No redesign of the import UI.
- No background worker replacement.

## Open Questions

No open questions.

## Decisions

### D-001 — Status is persisted on the import record

```yaml
id: D-001
status: accepted
context: Status must survive process restarts and be queryable later.
decision: Persist status on the import record rather than only in memory.
impact: Requires data-model update or use of an existing durable status field.
linked_artifacts: [AC-001, SL-001]
```

### D-002 — Submission flow remains compatible

```yaml
id: D-002
status: accepted
context: Existing clients already submit imports through the current flow.
decision: Do not break the existing import submission contract.
impact: Status tracking must be additive.
linked_artifacts: [AC-003, C-001, SL-002]
```

## Acceptance Criteria

### AC-001 — Import status is durable

```yaml
id: AC-001
status: active
statement: Import status is persisted durably and can be retrieved after process restart.
linked_slices: [SL-001]
```

### AC-002 — Import status transitions are observable

```yaml
id: AC-002
status: active
statement: Import status can represent pending, processing, completed, and failed states.
linked_slices: [SL-001, SL-002]
```

### AC-003 — Existing submission behavior remains compatible

```yaml
id: AC-003
status: active
statement: Existing import submission behavior remains compatible for current clients.
linked_slices: [SL-002]
```

## Constraints

### C-001 — Do not break import submission contract

```yaml
id: C-001
status: active
constraint: Do not remove or rename existing import submission inputs or response fields.
reason: Current clients must continue working.
linked_artifacts: [D-002, AC-003, SL-002]
```

### C-002 — Do not replace the worker architecture

```yaml
id: C-002
status: active
constraint: Do not replace the current background processing architecture as part of this feature.
reason: The feature is status tracking, not worker redesign.
linked_artifacts: [SL-001, SL-002]
```

## Risks

### R-001 — Status drift between worker and persisted record

```yaml
id: R-001
status: open
risk: Worker execution may diverge from persisted status if updates are not centralized.
impact: high
mitigation: Define one status update path and link it to SL-001.
linked_artifacts: [SL-001, C-002]
```

## Slices

### SL-001 — Persist import status model

```yaml
id: SL-001
status: ready
goal: Persist durable import status transitions on the import record.
scope: Add or use durable status storage and define allowed status values.
out_of_scope: Public UI changes, worker replacement, submission contract changes.
linked_acceptance_criteria: [AC-001, AC-002]
linked_decisions: [D-001]
linked_constraints: [C-002]
linked_risks: [R-001]
linked_questions: []
validation_hints:
  - Status values must be durably observable after process restart.
  - Pending, processing, completed, and failed states must be representable.
context_hints:
  - import record/model
  - persistence layer
  - background processing status update path
slice_readiness:
  status: ready
  blockers: []
  missing: []
completion_summary: null
```

### SL-002 — Expose import status without breaking submission

```yaml
id: SL-002
status: ready
goal: Expose import status while preserving existing import submission behavior.
scope: Add status query/read behavior and maintain compatibility with current submission flow.
out_of_scope: UI redesign, new file formats, worker replacement.
linked_acceptance_criteria: [AC-002, AC-003]
linked_decisions: [D-002]
linked_constraints: [C-001, C-002]
linked_risks: []
linked_questions: []
validation_hints:
  - Status must be observable through the chosen query/read path.
  - Existing import submission inputs and response fields must remain compatible.
context_hints:
  - import submission endpoint or service
  - import status query/read path
slice_readiness:
  status: ready
  blockers: []
  missing: []
completion_summary: null
```

## QA Checklist

```yaml
qa_checklist:
  spec_quality_gate:
    status: ready
    blockers: []
    checks:
      canonical_ids: pass
      open_questions: pass
      acceptance_coverage: pass
      anti_drift_constraints: pass
      risk_coverage: pass
      traceability: pass
      slice_readiness: pass
      validation_hints: pass
```

## Traceability Matrix

| Slice | ACs | Constraints | Risks | Decisions | Questions |
|---|---|---|---|---|---|
| `SL-001` | `AC-001`, `AC-002` | `C-002` | `R-001` | `D-001` | — |
| `SL-002` | `AC-002`, `AC-003` | `C-001`, `C-002` | — | `D-002` | — |

## Resume Notes

```yaml
last_completed_slice: null
next_candidate_slice: SL-001
blocked_by: []
context_to_load_next: [SL-001, AC-001, AC-002, C-002, R-001, D-001]
```
