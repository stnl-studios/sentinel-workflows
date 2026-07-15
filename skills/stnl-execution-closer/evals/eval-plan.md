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

1. Accepts only complete serial mappings with final `PASS` and covered requirements.
2. Ignores attempt-history hashes and compares each path only with the last effective base in declared serial order.
3. Accepts a later slice that includes and validates a shared path; blocks when that later slice omits it.
4. Blocks changed final-owner paths, unowned final changes, malformed removals, and unvalidated reappearance.
5. Requires exactly one valid PASS-origin Effective Validation Base for every completed slice.
6. Never runs tests, invokes a runner, changes artifacts, repairs evidence, or completes pending slices.
