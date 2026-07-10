# File Purpose Header

```yaml
purpose: Template for the checklist and complete operational evidence of one execution slice.
status: ready
read_when: Executing, validating, correcting, revalidating, finalizing, or auditing this slice.
do_not_read_when: A different slice is active and does not depend on this detailed evidence.
contains: Metadata, requirements references, checklist, expected areas, acceptance, tests, actual changes, scope expansion, evidence, findings, corrections, revalidation, diff summary, final result, and optional commit.
owner: stnl-spec-execution-manager
update_policy: MATERIALIZE_TASKS creates; EXECUTE_SLICE, VALIDATE_SLICE, APPLY_FINDINGS, and FINALIZE_SLICE update this slice record; COMMIT_SLICE may append only optional commit metadata.
```

# Slice 01 Tasks - <Name>

## Metadata

```yaml
slice: 01
requirements_source: <relative path from this file>
plan: ../plans/slice-01.md
tasks_index: ../tasks.md
covered_references: [AC-001, C-001]
blocking_divergence: false
```

## Checklist

- [ ] 1.1 <task> | expected areas: <paths or systems> | acceptance: AC-001
- [ ] 1.2 <task> | expected areas: <paths or systems> | acceptance: AC-001

## Expected Tests

- <Relevant test, suite, command, or observable check.>

## Changed Areas

- pending

## Scope Expansion

- none

## Execution Evidence

```yaml
tests_executed: []
test_result: pending
validation: pending
corrections: []
revalidation: pending
```

Use `test_result: PASS` only with at least one real `tests_executed` item. If no test applies, keep `tests_executed: []`, set `test_result: not_applicable`, and add one objective `test_reason`. Omit `test_reason` when tests run.

## Validation Findings

- pending

## Corrections Applied

- pending

## Revalidation

- pending

## Diff Summary

- pending

## Final Result

- pending

## Optional Commit

- not_requested
