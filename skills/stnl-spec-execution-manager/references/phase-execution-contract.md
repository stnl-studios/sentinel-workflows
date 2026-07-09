# File Purpose Header

```yaml
purpose: Define evidence-preserving delivery, independent validation, correction, and conclusion of one phase.
status: not_applicable
read_when: Delivering, validating, correcting, or concluding a materialized phase.
do_not_read_when: Creating initial plans or reviewing an unrelated phase.
contains: Minimum reads, permitted updates, verdicts, correction rules, and conclusion protocol.
owner: stnl-spec-execution-manager
update_policy: Change only when delivery evidence or validation boundaries change.
```

# Phase Execution Contract

## Deliver

Read the requirements source, selected `plans/plan-NN.md`, selected `tasks/tasks-NN.md`, linked requirements records, and strictly related code. Read compact indices only for discovery. Do not load unrelated plans, completed task files, all source records, or the repository by default.

The executor may implement scoped work, run tests, complete individual tasks, and record concise evidence. It must not complete a phase row.

## Test evidence

A concluded phase accepts only final test evidence. With executed tests, `tests_executed` lists at least one non-empty test, suite, or command, `test_result: PASS`, and `test_reason` is absent. When no test applies, record `tests_executed: []`, `test_result: not_applicable`, and one objective non-generic `test_reason` explaining why the phase has no executable or observable test. Do not invent tests to satisfy evidence. Pending, failed, missing, malformed, or contradictory test evidence cannot conclude a phase.

## Validate

Validation is independent and read-only for code. Compare the phase diff with the detailed plan, detailed tasks, requirements references, and test record. Return exactly `PASS` or `NEEDS_FIX`, recording the verdict and findings in the selected task record.

Each finding includes the problem, evidence, impact, related requirement/plan/task, and expected correction. Validation never implements a correction, records `revalidation`, finalizes detailed evidence, concludes a phase, or updates compact indices.

## Correct and conclude

Finalization processes the persisted verdict. For an initial `PASS`, it records `revalidation: not_required`, finalizes detailed evidence, and updates both compact indices without another validation. For `NEEDS_FIX`, it corrects only the reported findings and necessary effects, reruns relevant tests when tests apply, records the correction, and requests focused revalidation. If a requirement, scope, dependency, or strategy changes, stop and return the divergence to the requirements owner.

Only after focused revalidation `PASS` may conclusion finish detailed evidence and mark both compact phase rows `[x]`. Do not create the next task file automatically or erase earlier records during active delivery.
