# File Purpose Header

```yaml
purpose: Template for compact global progress across all materialized execution slices.
status: ready
read_when: Discovering slice eligibility, dependencies, global completion, detailed task paths, test summary, validation summary, or final result.
do_not_read_when: The selected detailed task file is already known and no global progress decision is needed.
contains: Canonical slice checkboxes, summaries, dependencies, detailed task paths, test summaries, validation summaries, and final results.
owner: stnl-spec-execution-manager
update_policy: MATERIALIZE_TASKS creates all rows; FINALIZE_SLICE updates exactly one row after evidence passes.
```

# Execution Tasks

## Progress Authority

Use only `[ ]` and `[x]`. This file is the canonical global progress authority. `plan.md` must not duplicate these checkboxes.

This file may identify open slices, dependency completion, and blocking divergences to express slice eligibility. It may present the first eligible slice only as a suggested next slice; it never selects one. `EXECUTE_SLICE`, `VALIDATE_SLICE`, `APPLY_FINDINGS`, and `FINALIZE_SLICE` block without an explicit `SLICE`, including when exactly one slice is eligible. `PARALLELIZE_SLICES` blocks without explicit `SLICES` and never infers additional candidates.

| Done | Slice | Delivery | Dependencies | Detail | Tests | Validation | Result |
|---|---|---|---|---|---|---|---|
| [ ] | 01 - <name> | <compact delivery summary> | - | tasks/slice-01.md | pending | pending | - |
| [ ] | 02 - <name> | <compact delivery summary> | 01 | tasks/slice-02.md | pending | pending | - |
