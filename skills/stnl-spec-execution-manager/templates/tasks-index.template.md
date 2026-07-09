# File Purpose Header

```yaml
purpose: Template for the cumulative compact index of detailed delivery task records.
status: ready
read_when: Discovering which task record exists, phase conclusion, or pending work.
do_not_read_when: The detailed tasks file for the selected phase is already known.
contains: Binary phase rows, detailed paths, tests, validation, and outcomes.
owner: stnl-spec-execution-manager
update_policy: Initial planning creates; conclusion updates completed phases and materializes the next safe task file.
```

# Delivery Tasks Index

| Done | Phase | Tasks | Detail | Tests | Validation | Result |
|---|---|---|---|---|---|---|
| [ ] | 01 - <name> | <count or compact summary> | tasks/tasks-01.md | pending | pending | - |
