# File Purpose Header

```yaml
purpose: Template for the compact global slice progress authority.
status: draft
read_when: PLAN/REPLAN creates progress or another operation checks global completion and dependencies.
do_not_read_when: A selected task file supplies all necessary local detail.
contains: One binary row per approved serial slice with dependencies, detail path, validation, and result.
owner: stnl-execution-planner
update_policy: PLAN/REPLAN creates rows and may commit approved supersession; successful VALIDATE_SLICE changes its selected row to PASS.
```

# Execution Tasks

| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |
|---|---|---|---|---|---|---|
| [ ] | 01 - <name> | <observable delivery> | - | tasks/slice-01.md | pending | pending |
