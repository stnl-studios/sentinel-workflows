# File Purpose Header

```yaml
purpose: Show successful documentary consolidation into one final SPEC file.
status: closed
read_when: A concrete CLOSE output shape is needed.
do_not_read_when: The workspace is still active or documentary blockers are unresolved.
contains: Before and after trees plus durable final-content boundaries.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with the CLOSE policy.
```

# CLOSE Result

Before CLOSE, the workspace has `feature_spec.md` and only the materialized records in `shared/`.

After a successful documentary cross-check:

```text
specs/invitation-expiration/
├── feature_spec.md
└── execution/ (unchanged when present; outside lifecycle ownership)
```

The final file retains expiration behavior, scope, final criteria, the public-contract constraint, time-handling risk, and durable decisions. It does not retain low-value resolved questions, working notes, logs, or lifecycle records; a separate execution workspace is neither read nor removed by CLOSE.
