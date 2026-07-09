# File Purpose Header

```yaml
purpose: Define the canonical slice model used as the unit of external agent execution.
load_when: Creating, validating, replanning, or updating slices.
do_not_load_when: Only closing final business rules without slice history.
contains: Slice file definition, required fields, statuses, sizing rules, readiness rules, and update rules.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when the execution unit changes.
```

# Slice Model

A slice is the canonical unit of execution and lives in its own file: `slices/SL-###.md`.

## Definition

A slice is the smallest useful unit of delivery that can pass through one complete external agent round with high quality:

```text
orchestrator -> planner -> test planner -> coder -> validator -> reviewer -> finalizer
```

The slice must be small enough to fit a single round without excessive context, but large enough to justify that round.

Filename, heading ID, and explicit `id:` field must match exactly. Do not store complete slice definitions inside operational `feature_spec.md`.

## Slice type

A slice may be:

- functional;
- technical;
- structural;
- preparatory;
- infrastructure-related.

A technical slice is allowed only when it has a clear relationship to the feature, risk reduction, stability, maintainability, or unlocks future acceptance criteria.

## Required slice fields

Each `slices/SL-###.md` file should contain:

```yaml
id: SL-###
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
  - <observability or validation hint, not a test case>
context_hints:
  - <file, module, subsystem, API, or domain hint>
completion_summary: <empty until done>
```

Use empty arrays only when the absence is intentional and safe.

The slice must link IDs only. Do not duplicate full acceptance criteria, decision text, constraints, risks, or question text inside the slice.

## Allowed statuses

| Status | Meaning |
|---|---|
| `planned` | Slice exists but is not ready for execution. |
| `ready` | Slice can enter the external agent round. |
| `blocked` | Slice cannot execute due to open questions, missing context, invalid links, or unresolved risks. |
| `done` | Slice completed successfully and the finalizer updated the spec. |
| `dropped` | Slice was canceled. The ID remains reserved forever. |

Do not use intermediate implementation statuses such as `implemented`, `validated`, or `reviewed` in the spec. Those belong to the external execution round. If the full round does not complete successfully, the spec is not updated.

## Sizing rules

A good slice is not too small and not too large.

### Too small

A slice is too small when it is merely:

- creating one file;
- renaming a function;
- adding one import;
- writing one isolated test;
- changing copy with no meaningful product or technical objective;
- a task that should be internal to a larger slice.

### Too large

A slice is too large when:

- it requires multiple independent behaviors;
- it spans unrelated subsystems;
- it needs unresolved architectural decisions;
- it needs too much repository context;
- it cannot be planned, implemented, validated, reviewed, and finalized in one high-quality round;
- it creates high likelihood of drift.

## Ready rules

A slice can be `ready` only when:

1. `goal` is clear;
2. `scope` and `out_of_scope` are explicit;
3. at least one `AC-###` is linked;
4. relevant `C-###` constraints are linked;
5. relevant `R-###` risks are linked or explicitly absent;
6. no linked `Q-###` is open;
7. `validation_hints` are present;
8. dependencies on other slices or artifacts are explicit;
9. context hints are sufficient for a focused agent round;
10. the slice is neither too small nor too large.

## Updating a completed slice

Only the finalizer may update a slice file to `done`, and only after the complete external agent round succeeds.

The finalizer may add a compact `completion_summary`, such as:

```yaml
completion_summary:
  result: <what was completed>
  satisfied_acceptance_criteria: [AC-###]
  new_decisions: [D-###]
  new_risks: [R-###]
  new_constraints: [C-###]
  follow_up_slices: [SL-###]
```

Keep the summary short. Do not include failed attempts, logs, or internal agent debate.

After updating a slice file, the finalizer must update compact index metadata, traceability, QA state, and resume notes in the same logical patch.

## Reopening completed work

Do not reopen a `done` slice for new work. Create a new corrective or follow-up slice using the next available `SL-###`.
