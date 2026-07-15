# File Purpose Header

```yaml
purpose: Template for compact global execution strategy and serial slice coverage.
status: draft
read_when: PLAN creates or REVIEW_PLAN checks the global execution plan.
do_not_read_when: A selected detailed plan already supplies all necessary local context.
contains: Requirements source, objective, strategy, approval state, serial slice order, dependencies, coverage, and detailed plan paths.
owner: stnl-execution-planner
update_policy: PLAN creates as draft; REVIEW_PLAN corrects and changes status to ready.
```

# Execution Plan

## Global Context

- Requirements source: `<relative path>`
- Objective: <compact objective>
- Strategy: <compact strategy>
- Review state: pending

## Serial Slice Order

| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |
|---|---|---|---|---|---|
| 01 - <name> | <result> | - | AC-001 | <areas> | plans/slice-01.md |

## Global Risks and Integration

- <risk, boundary, or explicit final integration slice>

`tasks.md` is the only global progress authority and does not exist until approved plans are materialized.

