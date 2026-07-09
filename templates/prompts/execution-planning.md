# File Purpose Header

```yaml
purpose: Prompt template for optional delivery planning from a clear requirements source.
status: ready
read_when: A caller requests a conservative delivery plan and initial detailed tasks.
do_not_read_when: A selected phase is already being delivered, validated, or concluded.
contains: Source input, planning sequence, self-critique, and divergence boundary.
owner: stnl-spec-execution-manager
update_policy: Update when initial planning behavior changes.
```

Use stnl-spec-execution-manager.

Requirements source: <path>
Requested scope or phase: <whole source or stated boundary>
Operational constraints: <location, time, compatibility, or none>

Read the source and only relevant code. Create `plan.md`, every `plans/plan-NN.md`, self-critique and correct coverage, dependencies, sizing, risks, and parallel safety, then create `tasks.md` and only the next executable `tasks/tasks-NN.md`. Preserve the source. Stop and report any requirements ambiguity, conflict, scope change, or material strategy decision.
