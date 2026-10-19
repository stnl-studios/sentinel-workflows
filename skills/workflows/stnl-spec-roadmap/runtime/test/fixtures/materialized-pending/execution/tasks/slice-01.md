# File Purpose Header

```yaml
purpose: Pristine task for Foundation.
status: ready
read_when: Preparing the initial invitation execution image.
do_not_read_when: Another delivery is selected.
contains: Current authority and initial delivery carriers.
owner: stnl-execution-planner
update_policy: Author writes; reviewer approves the final bytes.
```

# Slice 01 Tasks - Foundation

## References

- Slice: 01
- Delivery ID: 11111111-1111-4111-8111-111111111111
- Plan: `../plans/slice-01.md`
- Requirements source: `../../feature_spec.md`
- Requirements authority: sha256:11aba916db71705bfb2f518aac2b8f808c5f410559b1693949764b318b0f6424
- Plan revision: 1
- Local revision: 1
- Global tasks: `../tasks.md`

## Result

Invitation export prepared.

## Acceptance Obligations

- obligation-01 | requirement: AC-001 | contribution: partial | full owner: slice-02 | condition: Invitation export compiles | proof: Prepared node test
- obligation-02 | requirement: AC-002 | contribution: complete | full owner: slice-01 | condition: Expired invitation is rejected | proof: Approved prepared test

## Authorized Areas

- directory: `../../../../../test`

## Expected Files

- `../../../../../test/fixtures/invitations.json`

## Existing Inputs

- none

## Protected Responsibilities

- Keep authentication unchanged.

## Checklist

- [ ] 1.1 Implement eligible invitation acceptance | obligations: obligation-01
- [ ] 1.2 Reject expired invitations | obligations: obligation-02

## Expected Tests

- Mechanical documentary setup; no behavior verdict.

## Verification Recipe

- Recipe: {"format":"stnl-verification-recipe-v1","base":"workspace","cwd":".","checks":[{"id":"verification-01","executable":{"literal":"node"},"args":[{"literal":"-e"},{"literal":"if (2+2!==4) process.exit(1)"}],"inputs":[]}],"dependencyReview":"Mechanical documentary fixture only; no claim of invitation behavior verification."}

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
