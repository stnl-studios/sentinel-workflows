# File Purpose Header

```yaml
purpose: Template for compact global execution strategy and serial slice coverage.
status: draft
read_when: PLAN creates or REVIEW_PLAN checks the global execution plan.
do_not_read_when: A selected detailed plan already supplies all necessary local context.
contains: Requirements source, objective, strategy, approval state, serial slice order, dependencies, coverage, and detailed plan paths.
owner: stnl-execution-planner
update_policy: PLAN creates revision 1; REPLAN drafts a replacement or extension; REVIEW_PLAN corrects the mutable draft and changes it to ready.
```

# Execution Plan

## Global Context

- Requirements source: `<relative path>`
- Requirements authority: sha256:<64hex>
- Plan revision: <positive integer>
- Objective: <compact objective>
- Strategy: <compact strategy>
- Review state: pending

## Serial Slice Order

| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |
|---|---|---|---|---|---|
| 01 - <name> | <result> | - | AC-001 | directory: `<repository-relative physical target>` | plans/slice-01.md |

## Delivery Continuity

- runtime

## Global Risks and Integration

- <risk, boundary, or explicit final integration slice>

`tasks.md` is the sole global progress authority. PLAN produces Plan and Tasks together; only joint independent REVIEW_PLAN activates execution.
