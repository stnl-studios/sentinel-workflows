# File Purpose Header

```yaml
purpose: Store anti-drift constraints for <feature>.
status: draft
read_when: A slice links C-### IDs or readiness validation checks constraints.
do_not_read_when: The current slice links no constraints.
contains: C-### artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME may update; finalizer may append durable constraints after a fully successful round.
```

# Constraints

### C-001 - <Constraint title>

```yaml
id: C-001
status: active
constraint: <Boundary that implementation agents must not violate.>
reason: <Why this protects scope, contract, architecture, or behavior.>
linked_artifacts: [SL-001]
```
