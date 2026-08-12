# File Purpose Header

```yaml
purpose: Approved plan for the invitation confirmation UI slice.
status: ready
read_when: Executing or reviewing slice 02.
do_not_read_when: Another slice is active and no dependency requires this plan.
contains: References, result, scope, boundaries, dependencies, risks, strategy, expected tests, and completion criterion.
owner: stnl-execution-planner
update_policy: PLAN created it as draft; REVIEW_PLAN approved it and made it immutable to execution skills.
```

# Slice 02 - Confirmation UI

## References

- Slice: 02
- Requirements source: `../../feature_spec.md`
- Global plan: `../plan.md`
- Review state: approved

## Objective and Observable Result

An accepted eligible invitation presents confirmation copy approved by product.

## Requirements

- AC-001

## Included Scope

- Confirmation presentation and browser validation.

## Out of Scope and Boundaries

- API behavior remains owned by slice 01.

## Likely Areas

- Invitation UI and browser tests.

## Dependencies

- slice-01.

## Risks and Strategy

- Risk: Product copy is not yet authoritative.
- Strategy: Keep the scenario blocked until an explicit decision is persisted.

## Expected Tests

- Browser flow for eligible acceptance and confirmation presentation.

## Completion Criterion

- The displayed message exactly matches the persisted product decision.

