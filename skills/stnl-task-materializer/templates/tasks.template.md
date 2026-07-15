# File Purpose Header

```yaml
purpose: Template for the compact global slice progress authority.
status: ready
read_when: MATERIALIZE_TASKS creates progress or another operation checks global completion and dependencies.
do_not_read_when: A selected task file supplies all necessary local detail.
contains: One binary row per approved serial slice with dependencies, detail path, validation, and result.
owner: stnl-task-materializer
update_policy: MATERIALIZE_TASKS creates rows; only a successful VALIDATE_SLICE changes its selected row to complete.
```

# Execution Tasks

Use only `[ ]` and `[x]`. This is the sole global progress authority. A suggested eligible slice never selects it; every slice operation requires explicit `SLICE`.

| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |
|---|---|---|---|---|---|---|
| [ ] | 01 - <name> | <observable delivery> | - | tasks/slice-01.md | pending | pending |

After materialization, plans are immutable to every execution skill. After any operational evidence is recorded, this index cannot be recreated and checklists cannot be rematerialized. Only a current valid `PASS` may atomically change its selected row to `[x]`, validation `PASS`, and result `PASS`.
