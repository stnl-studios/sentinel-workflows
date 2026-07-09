# File Purpose Header

```yaml
purpose: Define operational closure, coverage checks, and explicit retention policies.
status: not_applicable
read_when: Delivery work is believed complete and operational closure is requested.
do_not_read_when: A selected phase still has pending work or a requirements divergence is unresolved.
contains: Closure cross-check, blockers, requirements-update boundary, and retention policies.
owner: stnl-spec-execution-manager
update_policy: Change only when operational closure policy changes.
```

# Operational Closure Policy

Cross-check the requirements source, `plan.md`, detailed plans, `tasks.md`, detailed task records, final code, tests, findings, corrections, revalidation, and evidence. Do not trust checkboxes alone.

Block closure if a required criterion lacks coverage, any phase is incomplete, a task remains open, a blocking finding remains, relevant tests are missing or failing, a recorded divergence is unresolved, or final behavior conflicts with the requirements source.

Choose one explicit policy:

- `validate_only`: assess and report compatibility; preserve requirements and all delivery artifacts.
- `consolidate_and_keep`: incorporate only user-authorized durable facts into the requirements source and retain delivery artifacts.
- `consolidate_and_remove`: incorporate only user-authorized durable facts into the requirements source and remove delivery artifacts after a successful cross-check.

Do not modify a requirements document to hide a gap. Never require consolidation or removal when the caller chose another policy.
