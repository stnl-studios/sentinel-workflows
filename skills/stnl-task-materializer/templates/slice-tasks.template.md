# File Purpose Header

```yaml
purpose: Template for one slice checklist and its compact execution and validation record.
status: ready
read_when: Materializing, executing, correcting, validating, revalidating, or auditing this slice.
do_not_read_when: Another slice is active and no dependency requires this record.
contains: References, checklist, tests, changes, overlap, divergences, implementation and findings test evidence, corrections, validation attempts, effective validation base, diff summary, and final result.
owner: stnl-task-materializer
update_policy: MATERIALIZE_TASKS creates; executor and quality manager update only their authorized sections.
```

# Slice 01 Tasks - <Name>

## References

- Slice: 01
- Plan: `../plans/slice-01.md`
- Requirements source: `<relative path>`
- Global tasks: `../tasks.md`

## Checklist

- [ ] 1.1 <task> | observable result: <result> | expected areas: <areas> | requirement: AC-001

## Expected Tests

- <test, command, suite, or observable check>

## Changed Areas

- pending

## Scope Expansion

- none

## Prior Validation Overlap

- none

## Divergences

- none

## Implementation Test Evidence

- none

Each automatic post-implementation check is append-only and uses the next globally sequential heading in this section. A later manual `EXECUTE_SLICE` continues the sequence instead of resetting it:

Discovery-only read operations are allowed and summarized under `Check discovery sources`; they are not verification commands.

### implementation-check-01

- Automatic check round: <1/3, 2/3, or 3/3 for the current manual operation>
- Status: TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED
- HEAD: <commit or not_available>
- Tested scope: <compact scope>
- Tested state:
  - `<relative/path>` | sha256:<64 lowercase hexadecimal characters>
  - `<removed/relative/path>` | REMOVED
- Check discovery sources: <relevant read-only discovery actions and sources consulted, such as project scripts, development docs, repository conventions, CI, manifests, Makefiles, task runners, nearby tests, or validator configuration>
- Verification types considered: <tests, builds, lint, typecheck, static inspection, validators, or other relevant types>
- Non-applicability rationale: <objective rationale only for TESTS_NOT_APPLICABLE or not_applicable>
- No verification-command confirmation: <confirm that no verification command was executed for TESTS_NOT_APPLICABLE or use not_applicable>
- Commands:
  - `<exact command>` | exit:<integer>
- Selected tests: <tests, suites, or checks>
- Selection rationale: <why this selection covers the changed scope>
- Coverage: <files or behaviors covered>
- Failures: <reported failures or none>
- Corrections covered: <paths and behaviors changed before this round or none>
- Reported failure from previous round: <failure that caused the correction or none>
- Correction applied before this round: <compact correction or none>
- Files altered between rounds: <relative paths or none>
- Updated scope and in-slice rationale: <updated scope and why the correction remains approved or not_applicable>
- Evidence or failure summary: <compact result>
- Blockers: <concrete blockers and required action or none>
- Unexpected workspace effects: <effects or none>
- Persistence summary: <compact summary>

## Findings Test Evidence

- none

Each automatic post-correction check is append-only, is associated with its findings cycle, and uses the next globally sequential heading in this section. A later manual `APPLY_FINDINGS` continues the sequence instead of resetting it:

Discovery-only read operations are allowed and summarized under `Check discovery sources`; they are not verification commands.

### findings-check-01

- Findings cycle: <attempt-NN or structured finding IDs>
- Automatic check round: <1/3, 2/3, or 3/3 for the current manual operation>
- Status: TESTS_PASS | TESTS_FAIL | TESTS_NOT_APPLICABLE | BLOCKED
- HEAD: <commit or not_available>
- Tested scope: <compact scope>
- Tested state:
  - `<relative/path>` | sha256:<64 lowercase hexadecimal characters>
  - `<removed/relative/path>` | REMOVED
- Check discovery sources: <relevant read-only discovery actions and sources consulted, such as project scripts, development docs, repository conventions, CI, manifests, Makefiles, task runners, nearby tests, or validator configuration>
- Verification types considered: <tests, builds, lint, typecheck, static inspection, validators, or other relevant types>
- Non-applicability rationale: <objective rationale only for TESTS_NOT_APPLICABLE or not_applicable>
- No verification-command confirmation: <confirm that no verification command was executed for TESTS_NOT_APPLICABLE or use not_applicable>
- Commands:
  - `<exact command>` | exit:<integer>
- Selected tests: <tests, suites, or checks>
- Selection rationale: <why this selection covers the corrections>
- Coverage: <files or behaviors covered>
- Findings verified: <finding IDs or none>
- Corrections covered: <paths and behaviors or none>
- Regressions selected: <related regressions and rationale or none>
- Findings not yet supported by tests: <finding IDs and reason or none>
- Failures: <reported failures or none>
- Reported failure from previous round: <failure that caused the correction adjustment or none>
- Correction applied before this round: <compact finding correction adjustment or none>
- Files altered between rounds: <relative paths or none>
- Updated scope and in-slice rationale: <updated scope and why the adjustment remains approved or not_applicable>
- Evidence or failure summary: <compact result>
- Blockers: <concrete blockers and required action or none>
- Unexpected workspace effects: <effects or none>
- Persistence summary: <compact summary>

## Validation Attempts

- none

Each persisted attempt is append-only and uses the next sequential heading:

### attempt-01

- Type: initial
- Status: PASS | NEEDS_FIX | BLOCKED
- HEAD: <commit or not_available>
- Verified scope: <compact scope>
- Commands:
  - `<exact command>` | exit:<integer>
- Evidence: <compact evidence>
- Findings: <structured finding references or none>
- Blockers: <concrete blockers or none>
- Unexpected workspace effects: <effects or none>
- Persistence summary: <compact summary>

## Validation Findings

- none

## Corrections Applied

- none

## Effective Validation Base

- none

On `PASS`, replace only the content of this section with exactly one base:

- Origin attempt: attempt-01
- Attempt type: initial
- HEAD: <commit or not_available>
- Result: PASS
- Files:
  - `<relative/path>` | sha256:<64 lowercase hexadecimal characters>
  - `<removed/relative/path>` | REMOVED
- Authoritative commands:
  - `<exact command>` | exit:<integer>
- Evidence summary: <compact evidence>

## Diff Summary

- pending

## Final Result

- pending
