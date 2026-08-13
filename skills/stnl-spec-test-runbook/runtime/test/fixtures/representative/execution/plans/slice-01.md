# File Purpose Header

```yaml
purpose: Approved plan for the invitation acceptance API slice.
status: ready
read_when: Executing or reviewing slice 01.
do_not_read_when: Another slice is active and no dependency requires this plan.
contains: References, result, scope, boundaries, dependencies, risks, strategy, expected tests, and completion criterion.
owner: stnl-execution-planner
update_policy: PLAN created it as draft; REVIEW_PLAN approved it and made it immutable to execution skills.
```

# Slice 01 - Invitation API

## References

- Slice: 01
- Requirements source: `../../feature_spec.md`
- Requirements authority: sha256:11aba916db71705bfb2f518aac2b8f808c5f410559b1693949764b318b0f6424
- Plan revision: 1
- Global plan: `../plan.md`
- Review state: approved

## Objective and Observable Result

Eligible and expired invitations produce the persistence and HTTP results defined by AC-001 and AC-002.

## Requirements

- AC-001
- AC-002

## Included Scope

- Eligible acceptance, duplicate prevention, and expired rejection.

## Out of Scope and Boundaries

- Confirmation copy belongs to slice 02.

## Likely Areas

- Invitation service and API integration tests.

## Dependencies

- None.

## Risks and Strategy

- Risk: Clock drift can destabilize boundary data.
- Strategy: Use fixtures comfortably before or after expiration and record service UTC time.

## Expected Tests

- API integration tests for eligible, duplicate, and expired invitation behavior.

## Completion Criterion

- AC-001 and AC-002 are observable through stable API and persistence results.
