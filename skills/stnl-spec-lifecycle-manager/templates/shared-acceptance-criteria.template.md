# File Purpose Header

```yaml
purpose: Store acceptance criteria for <feature>.
status: draft
read_when: A slice links one or more AC-### IDs or readiness validation checks acceptance coverage.
do_not_read_when: No current slice links acceptance criteria from this file.
contains: AC-### artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME may create or update; finalizer must not change ACs to hide requirement drift.
```

# Acceptance Criteria

### AC-001 - <Acceptance criterion title>

```yaml
id: AC-001
status: active
statement: <Observable behavior expected from the feature.>
linked_slices: [SL-001]
```
