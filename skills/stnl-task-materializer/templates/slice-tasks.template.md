# File Purpose Header

```yaml
purpose: Template for one pristine slice checklist and its empty execution and validation record.
status: ready
read_when: Materializing or classifying a pristine slice task.
do_not_read_when: Operational record schemas are needed after execution starts.
contains: References, checklist, expected tests, exact pristine sentinels, and pending final result.
owner: stnl-task-materializer
update_policy: MATERIALIZE_TASKS creates; later operations replace only their authorized sentinels using the execution-record schema.
```

# Slice 01 Tasks - <Name>

## References

- Slice: 01
- Plan: `../plans/slice-01.md`
- Requirements source: `<relative path>`
- Requirements authority: sha256:<64hex>
- Plan revision: <positive integer>
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

## Delegation Blocker

- none

## Implementation Test Evidence

- none

## Findings Test Evidence

- none

## Validation Attempts

- none

## Validation Findings

- none

## Corrections Applied

- none

## Effective Validation Base

- none

## Diff Summary

- pending

## Final Result

- pending
