# File Purpose Header

```yaml
purpose: Template for materialized canonical feature requirements.
status: ready
read_when: Scope, acceptance coverage, or a review finding names a requirement identifier.
do_not_read_when: No current concern requires a requirement from this file.
contains: R canonical requirement artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain requirements and explicit coverage exceptions without duplicating AC traceability.
```

# Requirements

### R-001 — Expired invitation is rejected

- status: in_scope

An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.

