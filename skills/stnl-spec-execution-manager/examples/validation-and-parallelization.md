# File Purpose Header

```yaml
purpose: Show persisted validation findings, correction, revalidation, and optional parallelization decisions for slices.
status: ready
read_when: A concrete example is needed for NEEDS_FIX handling or parallel safety assessment.
do_not_read_when: Only the base workspace layout or external-source handling is needed.
contains: Validation evidence, corrections, revalidation, allowed parallel work, and blocked parallel work.
owner: stnl-spec-execution-manager
update_policy: Keep aligned with validation, correction, finalization, and parallelization contracts.
```

# Validation and Parallelization

## NEEDS_FIX With Revalidation

`tasks/slice-02.md` records a validation problem without changing code during validation:

```yaml
tests_executed:
  - npm test -- invitation-lookup
test_result: PASS
validation: NEEDS_FIX
corrections: []
revalidation: pending
```

`## Validation Findings` contains:

- Problem: lookup response omits `expires_at` for accepted invitations.
- Evidence: diff updates pending invitation serialization only.
- Impact: AC-002 is only partially satisfied.
- Related reference: `plans/slice-02.md`, task 2.1, AC-002.
- Expected correction: serialize the expiration state for every lookup response covered by AC-002.

`APPLY_FINDINGS` later records the correction and reruns the affected test. `VALIDATE_SLICE` then persists `revalidation: PASS`. Only `FINALIZE_SLICE` can mark slice 02 `[x]` in `tasks.md`.

## Parallel Allowed

Slices 04 and 05 are eligible only after their detailed plans record concrete non-overlap:

- Slice 04 expected areas: `src/email/templates/reset-password`, template snapshot tests.
- Slice 05 expected areas: `docs/admin/invitation-retention.md`, documentation lint.
- Shared files, schemas, generated code, persistent state, mutable external resources, and order dependencies: none.

Parallel executions update only `tasks/slice-04.md` and `tasks/slice-05.md`. `tasks.md` is updated later in a serial finalization step.

## Parallel Blocked

Slices 02 and 03 are not parallel-safe when both touch `src/invitations/state.ts` or tests that mutate the same invitation records. The plans record the overlap and leave `parallelizable: false`. Execution waits for an explicit serial order or returns to plan review if the dependency was not anticipated.
