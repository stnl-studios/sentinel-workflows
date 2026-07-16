# File Purpose Header

```yaml
purpose: Template for materialized risks and their treatment.
status: ready
read_when: Scope, requirements, a constraint, or a review finding names a risk identifier.
do_not_read_when: No current concern requires a risk from this file.
contains: RK canonical risk artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME retain material exposure and explicit mitigation.
```

# Risks

### RK-001 — Clock drift near expiration boundary

- status: active
- impact: medium
- references: [C-001, AC-001]

#### Risco

Clock drift between service nodes can change the result near the expiration boundary.

#### Mitigação

Synchronize nodes, monitor drift, and retain the risk as active while it remains material.

