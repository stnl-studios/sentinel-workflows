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

Use only `[ ]` and `[x]`. This is the sole global progress authority. Every slice operation requires explicit `SLICE`.

| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |
|---|---|---|---|---|---|---|
| [ ] | 01 - Invitation API | Eligible and expired API behavior is deterministic. | - | tasks/slice-01.md | pending | pending |
| [ ] | 02 - Confirmation UI | Approved confirmation copy is presented. | slice-01 | tasks/slice-02.md | pending | pending |

Plans are immutable after materialization; only a current valid `PASS` may complete a selected row.

