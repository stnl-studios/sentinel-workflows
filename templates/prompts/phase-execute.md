# File Purpose Header

```yaml
purpose: Prompt template for delivering one materialized phase.
status: ready
read_when: A detailed plan and detailed task file are ready for a selected phase.
do_not_read_when: Initial planning, independent validation, or operational closure is active.
contains: Minimum inputs and delivery-only boundaries.
owner: stnl-spec-execution-manager
update_policy: Update when phase delivery boundaries change.
```

Use stnl-spec-execution-manager to deliver phase <NN> in <execution workspace>.

Read the named requirements source, `plans/plan-NN.md`, `tasks/tasks-NN.md`, linked records, and related code. Implement only the selected scope, complete individual tasks, and record tests and a concise diff summary in its detailed task file. Do not update phase checkboxes or compact indices. Stop and report a requirements divergence if scope, dependency, or strategy changes.
