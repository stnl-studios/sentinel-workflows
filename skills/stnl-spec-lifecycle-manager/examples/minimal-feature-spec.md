# File Purpose Header

```yaml
purpose: Minimal example of a slice-driven feature_spec.md.
load_when: The agent needs a small concrete example of the expected format.
do_not_load_when: The task is already clear or token budget is tight.
contains: One small feature spec with one slice and compact traceability.
owner: stnl-spec-lifecycle-manager
update_policy: Keep short.
```

# Invitation Expiration — Feature Spec

```yaml
purpose: Living feature specification for invitation expiration.
status: ready
mode_last_updated: PLANNING
canonical_artifacts: [Q, D, AC, SL, R, C]
read_when: Planning or resuming invitation expiration work.
do_not_read_when: Executing SL-001; use the slice context package instead.
```

## Spec Metadata

```yaml
spec_id: invitation-expiration
spec_status: ready
created_from_mode: INIT
last_updated_mode: PLANNING
current_slice: null
next_candidate_slice: SL-001
open_question_count: 0
```

## Objective

Allow invitations to expire after a configured expiration timestamp so stale invitations cannot be accepted indefinitely.

## Scope

- Store an expiration timestamp for invitations.
- Prevent acceptance of expired invitations.
- Expose expiration status through the existing invitation lookup behavior.

## Out of Scope

- No admin dashboard changes.
- No new notification workflow.
- No provider or email-template changes.

## Open Questions

No open questions.

## Decisions

### D-001 — Preserve existing invitation lookup contract

```yaml
id: D-001
status: accepted
context: Existing consumers depend on the invitation lookup response.
decision: Add expiration status without removing existing response fields.
impact: Implementation must preserve backward compatibility.
linked_artifacts: [AC-002, C-001, SL-001]
```

## Acceptance Criteria

### AC-001 — Expired invitation cannot be accepted

```yaml
id: AC-001
status: active
statement: An invitation with an expiration timestamp in the past cannot be accepted.
linked_slices: [SL-001]
```

### AC-002 — Expiration is observable in lookup

```yaml
id: AC-002
status: active
statement: Invitation lookup exposes whether the invitation is expired while preserving existing fields.
linked_slices: [SL-001]
```

## Constraints

### C-001 — Preserve public response compatibility

```yaml
id: C-001
status: active
constraint: Do not remove or rename existing invitation lookup response fields.
reason: Prevent breaking existing clients.
linked_artifacts: [D-001, AC-002, SL-001]
```

## Risks

### R-001 — Time comparison inconsistency

```yaml
id: R-001
status: open
risk: Expiration behavior may be inconsistent if time comparison uses mixed timezone assumptions.
impact: medium
mitigation: Use the system's existing time handling convention.
linked_artifacts: [SL-001]
```

## Slices

### SL-001 — Enforce invitation expiration

```yaml
id: SL-001
status: ready
goal: Prevent expired invitations from being accepted while exposing expiration state in lookup.
scope: Store/use expiration timestamp, enforce acceptance blocking, and expose expiration status.
out_of_scope: Admin UI, notifications, email-template changes.
linked_acceptance_criteria: [AC-001, AC-002]
linked_decisions: [D-001]
linked_constraints: [C-001]
linked_risks: [R-001]
linked_questions: []
validation_hints:
  - Expired invitations must be observably rejected by the existing acceptance flow.
  - Invitation lookup must preserve existing fields while exposing expiration state.
context_hints:
  - invitation domain/model
  - invitation acceptance flow
  - invitation lookup endpoint or service
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
| `SL-001` | `AC-001`, `AC-002` | `C-001` | `R-001` | `D-001` | — |

## Resume Notes

```yaml
last_completed_slice: null
next_candidate_slice: SL-001
blocked_by: []
context_to_load_next: [SL-001, AC-001, AC-002, C-001, R-001, D-001]
```
