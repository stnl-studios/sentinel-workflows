# File Purpose Header

```yaml
purpose: Define regression expectations for selected-slice execution, finding correction, and automatically delegated checks.
status: not_applicable
read_when: Changing executor behavior or its mutation boundaries.
do_not_read_when: Executing a stable selected slice.
contains: Explicit selection, selective reads, local writes, delegated checks, append-only test evidence, and prohibited formal-validation or completion cases.
owner: stnl-slice-executor
update_policy: Extend when execution crosses a slice or evidence boundary.
```

# Executor Eval Cases

1. Both operations reject missing or ambiguous `SLICE`.
2. Execution reads and changes only the selected slice and directly related code/tests.
3. Finding correction is limited to persisted findings and necessary effects.
4. After valid preconditions and implementation or correction, each manual operation invokes the configured runner at least once and at most three times, never a fourth time or through an unbounded loop, while the main context runs no verification command or fallback.
5. Records overlap with earlier completed slices and required regression justification in the current slice only.
6. Preserves concluded slices and all prior Validation Attempts during findings correction.
7. Execution and findings accept only `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE`, or `BLOCKED` and persist every round in separate append-only sections with global sequential identifiers.
8. No check status creates a Validation Attempt, Effective Validation Base, formal verdict, final result, or `[x]` row.
9. `TESTS_FAIL` in rounds one and two permits only evidence-backed in-scope correction before recheck; a third failure stops without a fourth invocation or another correction.
10. `TESTS_NOT_APPLICABLE` requires objective discovery sources, relevant read-only discovery actions, verification types considered, rationale, and no executed verification command; missing tooling, environment, dependency, permission, or an executed verification-command failure remains `BLOCKED` or `TESTS_FAIL`.
11. Execution failure creates no formal finding and starts no other operation; findings failure preserves findings and does not mark unsupported findings resolved.
12. No auxiliary status starts `VALIDATE_SLICE`, creates a manual retry operation, or changes formal validation authority.
13. Invalid preconditions may block before implementation with zero runner calls; once implementation or correction occurs, simple scope or probable non-applicability cannot bypass the mandatory first call.
