# File Purpose Header

```yaml
purpose: Define regression expectations for independent validation persistence and atomic PASS completion.
status: not_applicable
read_when: Changing VALIDATE_SLICE, validation-base persistence, or completion checks.
do_not_read_when: Running stable validation for one slice.
contains: Prerequisites, auxiliary test evidence, independent proportional checks, append-only attempts, exact verdict handling, findings, blocked states, effective PASS base, complete manifests, hashes, overlap, and completion cases.
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
9. Treats implementation and findings test evidence as auxiliary: it never creates an attempt, base, or completion before formal validation.
10. Reuses current sufficient evidence only proportionally and reruns necessary checks when tested state is stale, authority or coverage is insufficient, risk changed, or overlap requires regression.
11. A prior `TESTS_PASS` does not replace independent review or the current formal verdict.
12. A prior `TESTS_NOT_APPLICABLE` is reviewed independently for read-only discovery actions, sources consulted, verification types considered, omitted applicable checks, and tool absence incorrectly presented as non-applicability; it never guarantees `PASS` and creates no attempt or base before `VALIDATE_SLICE`.
13. Formal `NEEDS_FIX` may resolve corrected prior findings, preserve unresolved active findings, supersede with valid same-kind identity, and append new stable findings.
14. `PASS` atomically resolves/supersedes every remaining active blocking finding; resolved historical findings remain auditable and do not block completion or close.
15. Active blocking divergence blocks validation; resolved/superseded divergence history does not.
16. Explicit validation is the only continuation from third auxiliary `TESTS_FAIL`; executor re-entry remains blocked until its verdict.
17. Stale requirements/revision blocks before delegation; arbitrary user-owned SPEC-root siblings remain preserved and allowed.
18. Scoped runner, retry, or validation recovery reports the exact persisted operation and slice even when the current request is wrong; unscoped authority recovery keeps slice absent.

## Focused model regression: canonical authority versus green self-consistent tests

Use the existing model-eval procedure with fresh independent contexts and frozen inputs/model/effort; no live operation, synthetic approval or controller admission is implied. Keep the feature index and Plan/Task summary identical between the two controls and place the full AC in its indexed category.

- Negative: the canonical criterion explicitly requires A; implementation and a passing test expect B. The reviewer must read the canonical record and identify NEEDS_FIX from the actual required/produced/asserted mismatch, even though the test exits zero.
- Positive: canonical criterion, implementation and test all require/produce B. The reviewer may approve when the actual promised behavior is proved, without inventing a requirement for A.
- Freeze abstract values rather than the historical usage string. Compare reads, concrete evidence and verdicts, not just IDs mentioned in the answer or the test count. Use the existing evidence/report fields; no new schema or persisted authority is required.
- Validate the positive control's real entrypoint before spending model calls. A CLI requirement needs an exercised executable path, not only a helper returning an object. If the control is defective, preserve and exclude that trial; a repaired fixture needs a new baseline and cannot be compared as unchanged input.
- An instruction rewrite alone, a mocked model, static substring checks or a correct answer already produced before the rewrite do not prove a behavioral fix. Record non-reproduction, false rejections and budget limits honestly; never manufacture red/green.
