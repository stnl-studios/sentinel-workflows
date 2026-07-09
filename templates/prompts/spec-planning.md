# File Purpose Header

```yaml
purpose: Prompt template for read-only documentary readiness review of a feature SPEC.
status: ready
read_when: A user needs MODE PLANNING.
do_not_read_when: A documentary update or closure is requested.
contains: Review input, readiness checks, outputs, and no-mutation boundary.
owner: stnl-spec-lifecycle-manager
update_policy: Update when PLANNING behavior changes.
```

Use stnl-spec-lifecycle-manager.
MODE=PLANNING

SPEC path: <feature_spec.md or workspace>
Review focus: <whole SPEC or stated concern>

Read the feature document and only relevant shared records. Review documentary clarity, scope, criteria, blockers, decisions, constraints, risks, duplication, and references without changing files or exploring implementation. Return `planning_status: ready` or `planning_status: needs_resume`, `next_mode: RESUME`, and actionable findings with affected artifacts or IDs.
