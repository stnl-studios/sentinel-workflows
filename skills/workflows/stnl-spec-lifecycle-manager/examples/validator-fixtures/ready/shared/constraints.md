# File Purpose Header

```yaml
purpose: Template for materialized anti-drift constraints.
status: ready
read_when: Scope, requirements, a decision, or a review finding names a constraint identifier.
do_not_read_when: No current concern requires a constraint from this file.
contains: C canonical artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain constraints through explicit documentary changes.
```

# Constraints

### C-001 — Public error envelope remains stable

- status: active
- references: [D-001]

#### Restrição

Expired invitations use the existing public HTTP error envelope.

#### Razão

Clients already depend on that response contract.

