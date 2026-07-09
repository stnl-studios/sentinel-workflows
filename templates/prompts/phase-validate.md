# File Purpose Header

```yaml
purpose: Prompt template for independent read-only validation of one phase.
status: ready
read_when: A selected phase implementation and test record need assessment.
do_not_read_when: Correction, planning, or operational closure is the active operation.
contains: Validation inputs, required verdict, and finding shape.
owner: stnl-spec-execution-manager
update_policy: Update when validation evidence or independence rules change.
```

Use stnl-spec-execution-manager to validate phase <NN> in <execution workspace> without changing files.

Compare the phase diff, named requirements source, `plans/plan-NN.md`, `tasks/tasks-NN.md`, linked records, and test evidence. Return exactly `PASS` or `NEEDS_FIX`. For each finding, state problem, evidence, impact, related requirement/plan/task, and expected correction. Do not implement a fix.
