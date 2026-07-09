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

## Validate

Validation is independent and read-only for code. Compare the phase diff with the detailed plan, detailed tasks, requirements references, and test record. Return exactly `PASS` or `NEEDS_FIX`, recording the verdict and findings in the selected task record.

Each finding includes the problem, evidence, impact, related requirement/plan/task, and expected correction. Validation never implements a correction. An initial `PASS` records `revalidation: not_required`, finalizes detailed evidence, and updates both compact indices.

## Correct and conclude

For `NEEDS_FIX`, correct only the reported findings and necessary effects, rerun relevant tests, record the correction, and request focused revalidation. If a requirement, scope, dependency, or strategy changes, stop and return the divergence to the requirements owner.

Only after focused revalidation `PASS` may conclusion finish detailed evidence and mark both compact phase rows `[x]`. Do not create the next task file automatically or erase earlier records during active delivery.
