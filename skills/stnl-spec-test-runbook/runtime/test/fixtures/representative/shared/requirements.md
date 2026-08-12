# File Purpose Header

```yaml
purpose: Canonical invitation acceptance requirements.
status: ready
read_when: Scope, acceptance coverage, or a review finding names an invitation requirement.
do_not_read_when: No current concern requires a requirement from this file.
contains: R canonical requirement artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain requirements and explicit coverage exceptions without duplicating AC traceability.
```

# Requirements

### R-001 — Accept an eligible invitation

- status: in_scope

An eligible invitation creates participation exactly once and returns its generated identifier.

### R-002 — Reject an expired invitation

- status: in_scope

An invitation past its UTC expiration is rejected without creating participation.

### R-003 — Audit delivery telemetry

- status: in_scope
- coverage_justification: Delivery telemetry is covered by automated checks because no safe manual log access is available.

Delivery telemetry remains emitted and validated by the existing automated checks.

