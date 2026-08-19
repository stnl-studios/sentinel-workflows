# File Purpose Header

```yaml
purpose: Identify complete positive example workspaces exercised by the real lifecycle validator.
status: not_applicable
read_when: Maintainers need concrete active, blocked, or closed files rather than explanatory snippets.
do_not_read_when: A localized production SPEC record is already known.
contains: Ready, blocked, and closed positive fixtures with no model-eval claim.
owner: stnl-spec-lifecycle-manager
update_policy: Keep every fixture accepted by the embedded lifecycle tests and current validator only.
```

# Validator Fixtures

Each child directory is a complete positive example passed directly to `validate_workspace` by the deterministic runner:

- `ready/`: full ready authority with R-to-AC coverage.
- `blocked/`: blocking question with reciprocal AC link.
- `closed/`: exact consolidated authority.

These are structural and transition examples. They are not evidence that a model performed a lifecycle operation or judged semantic sufficiency.
