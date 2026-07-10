# File Purpose Header

```yaml
purpose: Define execution closure, cross-checks, artifact retention, and the boundary that prevents requirements edits.
status: not_applicable
read_when: Execution work is believed complete and CLOSE is requested.
do_not_read_when: A selected slice still has pending work or a requirements divergence is unresolved.
contains: Closure cross-check, blockers, requirements boundary, and execution-artifact retention policies.
owner: stnl-spec-execution-manager
update_policy: Change only when execution closure policy changes.
```

# Execution Closure Policy

Cross-check the requirements source, `plan.md`, `tasks.md`, detailed plans, detailed task files, final code, tests, findings, corrections, revalidation, and evidence. Do not trust checkboxes alone.

Block closure if a required criterion lacks coverage, any slice is incomplete, a mandatory task remains open, a blocking finding remains, relevant tests are missing or failing, a recorded divergence is unresolved, final behavior conflicts with the requirements source, or execution artifacts disagree with each other.

Choose one explicit policy:

- `validate_only`: assess compatibility and report the result; preserve requirements and all execution artifacts.
- `validate_and_keep`: validate compatibility and keep execution artifacts unchanged except for closure evidence requested by the caller.
- `validate_and_remove`: after successful validation and explicit caller request, remove only execution artifacts owned by this skill.

Closure never modifies the requirements source, lifecycle-owned files, or code. Destructive operations are never implicit.
