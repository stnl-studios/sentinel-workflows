# File Purpose Header

```yaml
purpose: Define regression expectations for independent validation persistence and atomic PASS completion.
status: not_applicable
read_when: Changing VALIDATE_SLICE, validation-base persistence, or completion checks.
do_not_read_when: Running stable validation for one slice.
contains: Prerequisites, append-only attempts, exact verdict handling, findings, blocked states, effective PASS base, complete manifests, hashes, overlap, and completion cases.
owner: stnl-slice-quality-manager
update_policy: Extend when quality persistence or completion accepts an invalid state.
```

# VALIDATE_SLICE Eval Cases

1. Blocks before delegation when checklist, artifacts, state, or divergence prerequisites fail.
2. `NEEDS_FIX` appends an attempt, persists structured findings, creates no effective base, and cannot complete.
3. `BLOCKED` appends an attempt, remains blocked, creates no effective base, and cannot be promoted or complete.
4. Direct `PASS` appends `attempt-01`, creates the one Effective Validation Base, and completes exactly one row.
5. Revalidation preserves every attempt, finding, and correction; only a current `PASS` atomically replaces the effective base.
6. Multiple findings cycles produce sequential IDs and only the final `PASS` attempt is authoritative.
7. Rejects duplicate, malformed, incomplete, unsorted, or inconsistent manifests and overlap without justified regressions.
8. Never completes from a historical `PASS`, `NEEDS_FIX`, or `BLOCKED` attempt.
