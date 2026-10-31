# File Purpose Header

```yaml
purpose: Detailed plan for Foundation.
status: ready
read_when: Preparing the initial invitation execution image.
do_not_read_when: Another delivery is selected.
contains: Current authority and initial delivery carriers.
owner: stnl-execution-planner
update_policy: Author writes; reviewer approves the final bytes.
```

# Slice 01 - Foundation

## References

- Slice: 01
- Delivery ID: 11111111-1111-4111-8111-111111111111
- Requirements source: `../../feature_spec.md`
- Requirements authority: sha256:11aba916db71705bfb2f518aac2b8f808c5f410559b1693949764b318b0f6424
- Plan revision: 1
- Local revision: 1
- Global plan: `../plan.md`
- Review state: approved

## Objective and Observable Result

Prepare the invitation export.

## Requirements

- AC-001: Invitation acceptance.
- AC-002: Expired invitation rejection.

## Included Scope

- Implement the invitation export.

## Out of Scope and Boundaries

- Do not alter authentication.

## Authorized Areas

- directory: `../../../../../test`

## Expected Files

- `../../../../../test/fixtures/invitations.json`

## Existing Inputs

- none

## Protected Responsibilities

- Keep authentication unchanged.

## Dependencies

- none

## Risks and Strategy

- Risk: a shared file could drift.
- Strategy: keep the edit scoped.

## Expected Tests

- Mechanical documentary setup; no behavior verdict.

## Verification Recipe

- Recipe: {"format":"stnl-verification-recipe-v1","base":"workspace","cwd":".","checks":[{"id":"verification-01","executable":{"literal":"node"},"args":[{"literal":"-e"},{"literal":"if (2+2!==4) process.exit(1)"}],"inputs":[]}],"dependencyReview":"Mechanical documentary fixture only; no claim of invitation behavior verification."}

## Completion Criterion

- Partial invitation check exists.
