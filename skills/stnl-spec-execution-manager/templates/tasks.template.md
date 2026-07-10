# File Purpose Header

```yaml
purpose: Template for compact global progress across all materialized execution slices.
status: ready
read_when: Discovering current slice, dependencies, global completion, detailed task paths, test summary, validation summary, or final result.
do_not_read_when: The selected detailed task file is already known and no global progress decision is needed.
contains: Canonical slice checkboxes, summaries, dependencies, detailed task paths, test summaries, validation summaries, and final results.
owner: stnl-spec-execution-manager
update_policy: MATERIALIZE_TASKS creates all rows; FINALIZE_SLICE updates exactly one row after evidence passes.
```

# Execution Tasks

## Progress Authority

Use only `[ ]` and `[x]`. This file is the canonical global progress authority. `plan.md` must not duplicate these checkboxes.

The current slice is the first `[ ]` row whose dependencies are `[x]` and whose detailed task file has no blocking divergence. If multiple slices are eligible, the caller must explicitly name which slice or slices to execute.

| Done | Slice | Delivery | Dependencies | Detail | Tests | Validation | Result |
|---|---|---|---|---|---|---|---|
| [ ] | 01 - <name> | <compact delivery summary> | - | tasks/slice-01.md | pending | pending | - |
| [ ] | 02 - <name> | <compact delivery summary> | 01 | tasks/slice-02.md | pending | pending | - |
