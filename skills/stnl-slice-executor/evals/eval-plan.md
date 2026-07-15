# File Purpose Header

```yaml
purpose: Define regression expectations for selected-slice execution and finding correction.
status: not_applicable
read_when: Changing executor behavior or its mutation boundaries.
do_not_read_when: Executing a stable selected slice.
contains: Explicit selection, selective reads, local writes, developer checks, and prohibited completion cases.
owner: stnl-slice-executor
update_policy: Extend when execution crosses a slice or evidence boundary.
```

# Executor Eval Cases

1. Both operations reject missing or ambiguous `SLICE`.
2. Execution reads and changes only the selected slice and directly related code/tests.
3. Finding correction is limited to persisted findings and necessary effects.
4. Neither operation invokes a runner, completes the global row, or writes a final result.
5. Records overlap with earlier completed slices and required regression justification in the current slice only.
6. Preserves concluded slices and all prior Validation Attempts during findings correction.
