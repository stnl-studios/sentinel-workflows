# File Purpose Header

```yaml
purpose: Compact global progress authority for invitation acceptance slices.
status: ready
read_when: Checking global completion, eligibility, or dependencies.
do_not_read_when: A selected task file supplies all necessary local detail.
contains: One binary row per approved serial slice with dependencies, detail path, validation, and result.
owner: stnl-task-materializer
update_policy: MATERIALIZE_TASKS created rows; only successful VALIDATE_SLICE may complete a selected row.
```

# Execution Tasks

Use only `[ ]` and `[x]`. This is the sole global progress authority. `PASS` and `SUPERSEDED` are terminal; only `PASS` is successful validation. A suggested eligible slice never selects it; every slice operation requires explicit `SLICE`.

| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |
|---|---|---|---|---|---|---|
| [ ] | 01 - Invitation API | Eligible and expired API behavior is deterministic. | - | tasks/slice-01.md | pending | pending |
| [ ] | 02 - Confirmation UI | Approved confirmation copy is presented. | slice-01 | tasks/slice-02.md | pending | pending |

After materialization, historical plans and task records are immutable. A wholly pristine canonical set may be atomically replaced only by explicit approved replanning. After any operational evidence, the index cannot be recreated and historical checklists cannot be rematerialized: an approved append-only revision adds only monotonically numbered rows/files. A current valid `PASS` atomically changes its selected row to `[x]`, validation `PASS`, result `PASS`. The same approved-replan materialization that appends a replacement slice may terminalize its named open predecessor as `[x]`, validation `SUPERSEDED`, result `SUPERSEDED`; it never changes a prior `PASS`.
