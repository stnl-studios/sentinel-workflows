# File Purpose Header

```yaml
purpose: Demonstrate minimum reads for documentary review of a selected concern.
status: ready
read_when: A SPEC maintainer needs a concrete selective-reading sequence.
do_not_read_when: The task is only about workspace shape or final consolidation.
contains: Review read sets for one question and one acceptance criterion.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with token economy and readiness gates.
```

# Selective Reading

To review whether `AC-002` is clear:

1. Read `feature_spec.md` for objective, scope, and artifact paths.
2. Read the `AC-002` block in `shared/acceptance-criteria.md`.
3. Load only the linked `D-001`, `C-001`, `R-001`, or `Q-001` records that affect it.
4. Compare the selected records for contradiction or missing context.
5. Report a documentary finding; do not expand the read set without a reason.

For CLOSE, start with the feature document and load only materialized records needed to consolidate durable content.
