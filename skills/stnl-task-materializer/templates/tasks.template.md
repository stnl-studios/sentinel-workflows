# File Purpose Header

```yaml
purpose: Template for the compact global slice progress authority.
status: ready
read_when: MATERIALIZE_TASKS creates progress or another operation checks global completion and dependencies.
do_not_read_when: A selected task file supplies all necessary local detail.
contains: One binary row per approved serial slice with dependencies, detail path, validation, and result.
owner: stnl-task-materializer
update_policy: MATERIALIZE_TASKS creates rows and may commit approved supersession; successful VALIDATE_SLICE changes its selected row to PASS.
```

# Execution Tasks

Use only `[ ]` and `[x]`. This is the sole global progress authority. `PASS` and `SUPERSEDED` are terminal; only `PASS` is successful validation. A suggested eligible slice never selects it; every slice operation requires explicit `SLICE`.

| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |
|---|---|---|---|---|---|---|
| [ ] | 01 - <name> | <observable delivery> | - | tasks/slice-01.md | pending | pending |

After materialization, historical plans and task records are immutable. A wholly pristine canonical set may be atomically replaced only by explicit approved replanning. After any operational evidence, the index cannot be recreated and historical checklists cannot be rematerialized: an approved append-only revision adds only monotonically numbered rows/files. A current valid `PASS` atomically changes its selected row to `[x]`, validation `PASS`, result `PASS`. The same approved-replan materialization that appends a replacement slice may terminalize its named open predecessor as `[x]`, validation `SUPERSEDED`, result `SUPERSEDED`; it never changes a prior `PASS`.
