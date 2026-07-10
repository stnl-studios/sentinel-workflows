# File Purpose Header

```yaml
purpose: Define execution closure, cross-checks, and the boundary that prevents requirements edits.
status: not_applicable
read_when: Execution work is believed complete and CLOSE is requested.
do_not_read_when: A selected slice still has pending work or a requirements divergence is unresolved.
contains: Closure cross-check, blockers, requirements boundary, and artifact ownership limits.
owner: stnl-spec-execution-manager
update_policy: Change only when execution closure policy changes.
```

# Execution Closure Contract

Cross-check the requirements source, `plan.md`, `tasks.md`, detailed plans, detailed task files, final code, tests, findings, corrections, revalidation, and evidence. Do not trust checkboxes alone.

`CLOSE` validates and reports. This report-only boundary is intentional: the operation returns status and blockers but does not alter or remove artifacts.

Block closure if a required criterion lacks coverage, any slice is incomplete, a mandatory task remains open, a blocking finding remains, relevant tests are missing or failing, a recorded blocking divergence is unresolved, final behavior conflicts with the requirements source, or execution artifacts disagree with each other.

Closure reports compatibility, inconsistencies, incomplete slices, blocking divergences, blocking findings, missing evidence, and blockers. It does not change the requirements source, lifecycle-owned files, execution artifacts, code, or any other file. It does not remove execution artifacts, persist retention decisions, decide cleanup, or accept retention variants. Any manual cleanup after closure is outside this skill.
