# File Purpose Header

```yaml
purpose: Define execution slice SL-### for <feature>.
status: planned
read_when: SL-### is the current or next candidate slice.
do_not_read_when: Working on another slice that does not depend on SL-###.
contains: Slice goal, scope, linked IDs, dependencies, validation hints, context hints, readiness, and completion summary.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME create or replan; finalizer may mark done after a fully successful round.
```

# SL-001 - <Slice title>

```yaml
id: SL-001
status: planned
goal: <One-sentence objective.>
scope: <What is included.>
out_of_scope: <What is excluded.>
linked_acceptance_criteria: [AC-001]
linked_decisions: []
linked_constraints: []
linked_risks: []
linked_questions: []
dependencies: []
validation_hints:
  - <What must be observable or verifiable later; not a test scenario.>
context_hints:
  - <Likely files, modules, APIs, subsystems, or domain areas.>
slice_readiness:
  status: incomplete
  blockers: []
  missing: [constraints, risks]
completion_summary: null
```
