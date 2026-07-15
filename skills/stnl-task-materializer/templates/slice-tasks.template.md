# File Purpose Header

```yaml
purpose: Template for one slice checklist and its compact execution and validation record.
status: ready
read_when: Materializing, executing, correcting, validating, revalidating, or auditing this slice.
do_not_read_when: Another slice is active and no dependency requires this record.
contains: References, checklist, tests, changes, overlap, divergences, findings, corrections, validation attempts, effective validation base, diff summary, and final result.
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

## Developer Checks

- none

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
