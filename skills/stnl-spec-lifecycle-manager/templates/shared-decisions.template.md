# File Purpose Header

```yaml
purpose: Store durable decisions for <feature>.
status: draft
read_when: A slice links D-### IDs or durable behavior decisions must be validated.
do_not_read_when: The current slice links no decisions.
contains: D-### artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME may update; developer may append durable decisions after Validator and Reviewer pass.
```

# Decisions

### D-001 - <Decision title>

```yaml
id: D-001
status: accepted
context: <Why this decision exists.>
decision: <The durable decision.>
impact: <Business, technical, or operational impact.>
linked_artifacts: [AC-001, SL-001]
```
