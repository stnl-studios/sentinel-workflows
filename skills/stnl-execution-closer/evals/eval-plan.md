# File Purpose Header

```yaml
purpose: Define regression expectations for read-only execution closure and drift detection.
status: not_applicable
read_when: Changing CLOSE behavior, hash verification, or global integrity checks.
do_not_read_when: Closing under stable contracts.
contains: Completion, mapping, coverage, findings, effective-base validity, serial final ownership, drift, removals, integration, and no-write cases.
owner: stnl-execution-closer
update_policy: Extend when closure accepts an inconsistent or changed workspace.
```

# CLOSE Eval Cases

1. Accepts only terminal serial mappings with final `PASS` or valid `SUPERSEDED`, covered current requirements, and current-revision PASS ownership.
2. Ignores attempt-history hashes and compares each path only with the last effective base in declared serial order.
3. Accepts a later slice that includes and validates a shared path; blocks when that later slice omits it.
4. Blocks changed final-owner paths, unowned final changes, malformed removals, and unvalidated reappearance.
5. Requires exactly one valid PASS-origin Effective Validation Base for every `PASS` slice and a valid later replacement for every `SUPERSEDED` slice.
6. Never runs tests, invokes a runner, changes artifacts, repairs evidence, or completes pending slices.
7. Accepts resolved/superseded historical findings/divergences and blocks only active blocking records.
8. Rejects stale requirements authority or authority change without a current-revision PASS reconciliation/corrective slice.
9. Routes immutable drift, missing integration, or corrective work to executable `REPLAN`; never prescribes validation of a concluded slice.
10. Returns only `EXECUTION_APPROVED` or `EXECUTION_BLOCKED`, distinct from documentary `SPEC_CLOSED`.
11. Allows and preserves arbitrary lifecycle-external/user-owned SPEC-root siblings while rejecting non-canonical execution paths and unsafe reserved entries.
