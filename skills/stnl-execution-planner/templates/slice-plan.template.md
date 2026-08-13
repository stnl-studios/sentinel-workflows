# File Purpose Header

```yaml
purpose: Template for one observable and testable serial delivery slice.
status: draft
read_when: PLAN creates or REVIEW_PLAN checks this detailed slice plan.
do_not_read_when: Another slice is active and no concrete dependency requires this plan.
contains: References, objective, observable result, scope, boundaries, dependencies, risks, strategy, expected tests, and completion criterion.
owner: stnl-execution-planner
update_policy: PLAN or REPLAN creates as draft; REVIEW_PLAN corrects only the mutable draft and changes it to ready.
```

# Slice 01 - <Name>

## References

- Slice: 01
- Requirements source: `<relative path>`
- Requirements authority: sha256:<64hex>
- Plan revision: <positive integer>
- Global plan: `../plan.md`
- Review state: pending

## Objective and Observable Result

<One coherent delivery and how it is observed.>

## Requirements

- AC-001

## Included Scope

- <included work>

## Out of Scope and Boundaries

- <excluded work and boundary with later slices>

## Likely Areas

- <path, contract, subsystem, or test area>

## Dependencies

- <earlier slice or none>

## Risks and Strategy

- Risk: <risk and mitigation>
- Strategy: <bounded approach>

## Expected Tests

- <test, command, suite, or observable check>

## Completion Criterion

- <objective result and preserved boundary>
