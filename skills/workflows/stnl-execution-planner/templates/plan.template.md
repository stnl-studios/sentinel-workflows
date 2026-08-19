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

For revision 1, including a planning-only replacement before tasks exist, omit the following historical recovery fields. Only a later revision recovering from materialized tasks records the deterministic reason and whether it is a pristine replacement or append-only extension:

- Replan reason: <REPLAN_REASON>
- Revision mode: pristine-replacement | append-only-extension
- Supersedes open slices: <slice-NN -> slice-NN mappings or none>

## Serial Slice Order

| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |
|---|---|---|---|---|---|
| 01 - <name> | <result> | - | AC-001 | <areas> | plans/slice-01.md |

## Global Risks and Integration

- <risk, boundary, or explicit final integration slice>

`tasks.md` is the only global progress authority and does not exist until approved plans are materialized.
