# File Purpose Header

```yaml
purpose: Template for a living slice-driven feature specification.
load_when: MODE is INIT, or RESUME needs to reconstruct missing structure.
do_not_load_when: MODE is CLOSE and a final clean structure is enough.
contains: Canonical feature_spec.md section layout with placeholders.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with references/spec-schema.md.
```

# <Feature Name> — Feature Spec

```yaml
purpose: Living feature specification for <feature>.
status: draft
mode_last_updated: INIT
canonical_artifacts: [Q, D, AC, SL, R, C]
read_when: Creating, resuming, planning, or finalizing this feature.
do_not_read_when: Executing a single ready slice; use the slice context package instead.
```

## Spec Metadata

```yaml
spec_id: <feature-slug>
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

## Open Questions

<!-- Use Q-001+. No spec may become ready while any question is open. -->

### Q-001 — <Question title>

```yaml
id: Q-001
status: open
question: <Smallest decision needed.>
why_it_matters: <Why this affects scope, behavior, risk, or implementation.>
blocks: [SL-001]
resolution: null
resolved_by: null
linked_decision: null
```

## Decisions

<!-- Use D-001+. Record only durable decisions. -->

### D-001 — <Decision title>

```yaml
id: D-001
status: accepted
context: <Why this decision exists.>
decision: <The durable decision.>
impact: <Business, technical, or operational impact.>
linked_artifacts: [AC-001, SL-001]
```

## Acceptance Criteria

<!-- Use AC-001+. Criteria must be observable but not test scenarios. -->

### AC-001 — <Acceptance criterion title>

```yaml
id: AC-001
status: active
statement: <Observable behavior expected from the feature.>
linked_slices: [SL-001]
```

## Constraints

<!-- Use C-001+. Constraints prevent drift. -->

### C-001 — <Constraint title>

```yaml
id: C-001
status: active
constraint: <Boundary that implementation agents must not violate.>
reason: <Why this protects scope, contract, architecture, or behavior.>
linked_artifacts: [SL-001]
```

## Risks

<!-- Use R-001+. Record material risks only. -->

### R-001 — <Risk title>

```yaml
id: R-001
status: open
risk: <What could go wrong.>
impact: low | medium | high
mitigation: <How the spec constrains or handles the risk.>
linked_artifacts: [SL-001, C-001]
```

## Slices

<!-- Use SL-001+. This is the canonical execution unit. -->

### SL-001 — <Slice title>

```yaml
id: SL-001
status: planned
goal: <One-sentence objective.>
scope: <What is included.>
out_of_scope: <What is excluded.>
linked_acceptance_criteria: [AC-001]
linked_decisions: [D-001]
linked_constraints: [C-001]
linked_risks: [R-001]
linked_questions: [Q-001]
validation_hints:
  - <What must be observable or verifiable later; not a test scenario.>
context_hints:
  - <Likely files, modules, APIs, subsystems, or domain areas.>
slice_readiness:
  status: blocked
  blockers: [Q-001]
  missing: []
completion_summary: null
```

## QA Checklist

```yaml
qa_checklist:
  spec_quality_gate:
    status: blocked
    blockers: [Q-001]
    checks:
      canonical_ids: pass
      open_questions: fail
      acceptance_coverage: pass
      anti_drift_constraints: pass
      risk_coverage: pass
      traceability: pass
      slice_readiness: fail
      validation_hints: pass
```

## Traceability Matrix

| Slice | ACs | Constraints | Risks | Decisions | Questions |
|---|---|---|---|---|---|
| `SL-001` | `AC-001` | `C-001` | `R-001` | `D-001` | `Q-001` |

## Resume Notes

```yaml
last_completed_slice: null
next_candidate_slice: null
blocked_by: [Q-001]
context_to_load_next: [SL-001, AC-001, C-001, R-001, D-001, Q-001]
```
