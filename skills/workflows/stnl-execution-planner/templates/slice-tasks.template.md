# File Purpose Header

```yaml
purpose: Template for one pristine slice checklist and its empty execution and validation record.
status: draft
read_when: Authoring or classifying a current pristine slice task.
do_not_read_when: Operational record schemas are needed after execution starts.
contains: References, checklist, expected tests, exact pristine sentinels, and pending final result.
owner: stnl-execution-planner
update_policy: PLAN authors the joint Initial candidate; later current operations publish only their authorized records.
```

# Slice 01 Tasks - <Name>

## References

- Slice: 01
- Delivery ID: runtime
- Plan: `../plans/slice-01.md`
- Requirements source: `<relative path>`
- Requirements authority: sha256:<64hex>
- Plan revision: <positive integer>
- Local revision: 1
- Global tasks: `../tasks.md`

## Result

<Local observable delivery and its practical outcome.>

## Acceptance Obligations

- obligation-01 | requirement: AC-001 | contribution: complete | full owner: slice-01 | condition: <observable condition> | proof: <required evidence>

## Authorized Areas

- directory: `<artifact-relative authorized subtree or exact file>`

## Expected Files

- `<artifact-relative predicted file>`

## Existing Inputs

- none

## Protected Responsibilities

- <protected semantic responsibility and exclusion>

## Checklist

- [ ] 1.1 <technical action> | obligations: obligation-01

## Expected Tests

- <test, command, suite, or observable check>

## Verification Recipe

- Recipe: {"format":"stnl-verification-recipe-v1","base":"workspace","cwd":".","checks":[{"id":"verification-01","executable":{"literal":"node"},"args":[{"literal":"--test"},{"file":{"kind":"product","path":"<verification file>"}}],"inputs":[]}],"dependencyReview":"<reviewed indirect dependencies>"}

## Continuity

- Current validation: unvalidated
- Current evidence: none
- Current action: implement approved delivery

## Operational Changes

- none

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
