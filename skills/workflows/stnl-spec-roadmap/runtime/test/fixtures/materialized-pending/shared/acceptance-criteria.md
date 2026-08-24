# File Purpose Header

```yaml
purpose: Canonical observable acceptance criteria for invitation acceptance.
status: ready
read_when: A requirement, scope boundary, or review finding names an invitation acceptance criterion.
do_not_read_when: No current concern requires an acceptance criterion from this file.
contains: AC canonical artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain criteria without hiding requirement conflicts or blockers.
```

# Acceptance Criteria

### AC-001 — Eligible invitation is accepted

- status: active
- verifies: [R-001]

When an eligible invitation is accepted, the API returns HTTP 201, participation is created exactly once, and the user sees confirmation.

### AC-002 — Expired invitation is rejected

- status: active
- verifies: [R-002]
- references: [RK-001]

When an invitation is already expired according to the service UTC clock, the API returns the public expiration error and creates no participation.

