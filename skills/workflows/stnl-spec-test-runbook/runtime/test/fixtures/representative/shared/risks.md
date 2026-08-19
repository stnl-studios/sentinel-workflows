# File Purpose Header

```yaml
purpose: Canonical invitation acceptance risks and treatment.
status: ready
read_when: Scope, requirements, or a review finding names an invitation risk.
do_not_read_when: No current concern requires a risk from this file.
contains: RK canonical risk artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME retain material exposure and explicit mitigation.
```

# Risks

### RK-001 — Clock drift near expiration boundary

- status: active
- impact: medium
- references: [AC-002]

#### Risco

Clock drift between service nodes can change results close to the expiration boundary.

#### Mitigação

Use data comfortably outside the boundary, record service UTC time, and retain the risk while it remains material.

