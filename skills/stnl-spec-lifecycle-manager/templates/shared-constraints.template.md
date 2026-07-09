# File Purpose Header

```yaml
purpose: Template for materialized anti-drift constraints.
status: ready
read_when: Scope, requirements, or a review finding names a constraint identifier.
do_not_read_when: No active SPEC concern requires a constraint from this file.
contains: C canonical artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain constraints through explicit documentary changes.
```

# Constraints

### C-001 - <Constraint title>

```yaml
id: C-001
status: active
constraint: <Boundary that must not be violated.>
reason: <Why the boundary matters.>
```
