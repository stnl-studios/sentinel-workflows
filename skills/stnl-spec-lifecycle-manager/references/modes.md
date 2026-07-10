# File Purpose Header

```yaml
purpose: Define preconditions, allowed changes, and completion behavior for the four SPEC lifecycle MODEs.
status: not_applicable
read_when: Selecting or applying INIT, RESUME, PLANNING, or CLOSE.
do_not_read_when: Only a canonical item shape or isolated relationship rule is needed.
contains: Mode boundaries, transitions, restrictions, and completion conditions.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when lifecycle semantics change.
```

# Lifecycle MODEs

Use exactly one MODE at a time. INIT and RESUME have non-overlapping preconditions.

## INIT

Create a new documentary SPEC. The target documentary workspace must not exist. Materialize only meaningful shared categories and the smallest blocking questions. Separate facts, hypotheses, and decisions. Apply readiness gates before declaring the new SPEC `ready`. Do not write code or operational artifacts.

## RESUME

Update or mature an existing SPEC; `feature_spec.md` must have existed before the operation. Apply explicit answers, decisions, corrections, or scope deltas to affected artifacts. RESUME may add information, resolve questions, create decisions, adjust criteria and links, and change documentary status when gates permit. Preserve all allocated IDs; never renumber or reuse them. Do not create operational artifacts.

## PLANNING

Read the existing SPEC selectively and make no changes. Evaluate readiness, expose blockers and inconsistencies, and identify relevant artifacts. Return `READY` when every applicable gate passes; otherwise return `NEEDS_RESUME` with only actionable documentary findings and affected files or IDs. Never create a delivery plan inside the documentary workspace.

## CLOSE

Consolidate only after every close precondition passes. Valid question states are `resolved`, `bypassed`, and `dropped`; `open` always blocks. Build and validate the durable final document before removing `shared/`, then validate the final form and external-directory preservation. Closure never depends on code, tests, commits, diffs, tasks, or implementation state.
