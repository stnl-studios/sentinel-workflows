# File Purpose Header

```yaml
purpose: Template for the compact index of all delivery phases.
status: ready
read_when: Discovering phase order, dependencies, coverage, or the next executable phase.
do_not_read_when: The detailed plan for one known phase is sufficient.
contains: Binary phase rows, source references, dependencies, parallel notes, detailed paths, and results.
owner: stnl-spec-execution-manager
update_policy: Initial planning creates; conclusion updates one completed phase at a time.
```

# Delivery Plan Index

## Requirements Source

```yaml
requirements_source: <relative requirements path>
execution_workspace: .
```

| Done | Phase | Objective | Dependencies | Covered IDs or criteria | Parallel | Detail | Result |
|---|---|---|---|---|---|---|---|
| [ ] | 01 - <name> | <one-line observable outcome> | - | AC-001 | no | plans/plan-01.md | - |
