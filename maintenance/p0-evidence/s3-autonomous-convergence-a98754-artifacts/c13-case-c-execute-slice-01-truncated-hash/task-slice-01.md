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

# Slice 01 Tasks - Compatible archived state

## References

- Slice: 01
- Plan: `../plans/slice-01.md`
- Requirements source: `../../feature_spec.md`
- Requirements authority: sha256:bd2e35a2bbaba6be5f1419da4dbf541393fa582d58a6ff4992728ce1310db597
- Plan revision: 1
- Global tasks: `../tasks.md`

## Checklist

- [x] 1.1 Establish compatible archived-state persistence with focused storage coverage | observable result: legacy and explicit archived Todo states retain byte-preserving reads, relative order, and field-shape-compatible writes | expected areas: `../../../../src/validation.mjs`; `../../../../src/todo-store.mjs`; `../../../../test/todo-store.test.mjs`; storage validation, persistence, and focused tests | requirement: R-002, R-003, R-010; AC-001, AC-002, AC-004, AC-013

## Expected Tests

- Run the focused store suite with `node --test test/todo-store.test.mjs`.
- Verify a legacy file without archived keys reads successfully as active-compatible data and retains identical bytes after every read-only scenario.
- Verify interleaved archived states retain their physical relative order and explicit archived values survive persistence.
- Verify a transition-oriented write changes only the targeted record's archived field and does not add archived=false to untouched legacy records.
- Verify malformed archived values or unsupported object shapes still fail deterministically.

## Changed Areas

- `../../../../src/todo-store.mjs`
- `../../../../src/validation.mjs`
- `../../../../test/todo-store.test.mjs`

## Scope Expansion

- none

## Prior Validation Overlap

- none

## Divergences

- none

## Delegation Blocker

- Operation: EXECUTE_SLICE
- Kind: malformed-output
- State: active
- After record: none
- Causes:
  - Runner returned malformed Tested state digest for `../../../../test/todo-store.test.mjs`: `sha256:3df38ddba0e66be87c1545531625c43d6fd5781ac938ad04573bda84bd2af` does not match the required sha256 token format with exactly 64 lowercase hexadecimal characters.
- Required action: Correct the runner output contract and resume the same EXECUTE_SLICE delegation; do not allocate a check identifier or retry this malformed response.

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

- Implemented optional archived-state validation and retention, preserved physical storage order, and added focused compatibility, byte-preservation, round-trip, and malformed-shape coverage.

## Final Result

- pending
