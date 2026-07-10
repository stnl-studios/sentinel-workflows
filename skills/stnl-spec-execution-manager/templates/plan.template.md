# File Purpose Header

```yaml
purpose: Template for compact global context across all planned execution slices.
status: ready
read_when: Discovering requirements source, overall strategy, slice order, dependencies, summaries, coverage, or detailed plan paths.
do_not_read_when: The selected detailed slice plan and task file already provide enough local context.
contains: Requirements source, objective, strategy, slice summaries, dependencies, coverage, likely areas, parallel notes, and detailed plan paths.
owner: stnl-spec-execution-manager
update_policy: PLAN creates; REVIEW_PLAN revises before task materialization; progress updates belong only in tasks.md.
```

# Execution Plan

## Global Context

- Fonte de requisitos: `<relative path from this file>`
- Execution root: `.`
- Objetivo geral: <short delivery objective>
- Estratégia: <compact global strategy>

## Slice Order

| Slice | Summary | Dependencies | Covered Requirements | Expected Areas | Parallelization | Detailed Plan |
|---|---|---|---|---|---|---|
| 01 - <name> | <short useful delivery summary> | - | AC-001 | <paths or areas> | no: <reason> | plans/slice-01.md |
| 02 - <name> | <short useful delivery summary> | 01 | AC-002 | <paths or areas> | no: depends on 01 | plans/slice-02.md |

## Global Notes

- Requirements source remains authoritative and is not edited by execution.
- This file summarizes context; `tasks.md` is the only global progress authority.
- Detailed strategy, task checklists, evidence, findings, and history stay in per-slice files.
