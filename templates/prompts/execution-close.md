# File Purpose Header

```yaml
purpose: Prompt template for operational delivery closure with an explicit retention policy.
status: ready
read_when: Delivery work is believed complete and a closure policy is supplied.
do_not_read_when: A phase, finding, requirement divergence, or relevant test remains unresolved.
contains: Cross-check inputs, blockers, and retention policy boundary.
owner: stnl-spec-execution-manager
update_policy: Update when operational closure policy changes.
```

Use stnl-spec-execution-manager.

Requirements source: <path>
Execution workspace: <path>
Closure policy: <validate_only | consolidate_and_keep | consolidate_and_remove; default for this repository prompt: consolidate_and_remove>

Cross-check the source, plan and task indices, detailed records, code, tests, findings, corrections, and revalidation. Block on any coverage gap or unresolved divergence. Apply only the selected policy; never modify the requirements source to conceal a delivery gap.
