# File Purpose Header

```yaml
purpose: Compact global execution strategy for invitation acceptance.
status: ready
read_when: Planning or reviewing the global invitation acceptance execution.
do_not_read_when: A selected detailed plan already supplies all necessary local context.
contains: Requirements source, objective, strategy, approval state, serial slices, dependencies, coverage, and detailed plan paths.
owner: stnl-execution-planner
update_policy: PLAN created it as draft; REVIEW_PLAN approved it and made it immutable to execution skills.
```

# Execution Plan

## Global Context

- Requirements source: `../feature_spec.md`
- Objective: Deliver API invitation acceptance followed by its confirmation UI.
- Strategy: Establish the service behavior before exposing the user flow.
- Review state: approved

## Serial Slice Order

| Slice | Observable delivery | Dependencies | Requirements | Expected areas | Detailed plan |
|---|---|---|---|---|---|
| 01 - Invitation API | Eligible and expired invitations have deterministic API results. | - | AC-001, AC-002 | invitation service, integration tests | plans/slice-01.md |
| 02 - Confirmation UI | The accepted invitation presents approved confirmation copy. | slice-01 | AC-001 | invitation UI, browser tests | plans/slice-02.md |

## Global Risks and Integration

- Record service UTC time for expiration checks and keep product copy approval explicit.

`tasks.md` is the only global progress authority.

