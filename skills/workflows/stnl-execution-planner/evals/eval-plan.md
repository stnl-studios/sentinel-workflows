# File Purpose Header

```yaml
purpose: Define regression expectations for PLAN.
status: not_applicable
read_when: Changing planner behavior, planning templates, or structural validators.
do_not_read_when: Running ordinary planning with stable contracts.
contains: PLAN success and failure cases.
owner: stnl-execution-planner
update_policy: Extend when a planner regression reveals a missing invariant.
```

# PLAN and REPLAN Eval Cases

1. Creates only global and detailed plan artifacts with `draft` headers and pending review state.
2. Preserves the requirements source and relative paths.
3. Covers every requirement with serial, observable, testable slices and explicit dependencies.
4. Adds a final integration slice when cross-slice verification is a real delivery requirement.
5. Rejects ambiguous requirements instead of inventing product decisions.
6. Runs only from `EMPTY`; existing plans, tasks, or unrelated content block without byte changes.
7. Never describes PLAN as replacement or reset.
8. Requires explicit `REPLAN_REASON` and derives pristine replacement versus append-only extension only from deterministic state.
9. Before tasks exist, atomically replaces the complete current planning authority, removes obsolete detailed plans, remains revision `1`, omits historical recovery fields, and returns through review plus initial materialization.
10. Replaces a wholly pristine canonical materialized plan/task set atomically under an increasing `pristine-replacement` revision, with no operational history loss.
11. After execution starts, preserves all history and appends monotonically numbered corrective, replacement, reconciliation, or integration slices under an increasing plan revision.
12. Detects requirements fingerprint changes before materialization, after materialization, during partial execution, and after all prior slices PASS; never treats stale plans as current.
13. Returns lifecycle `RESUME` without drafting when a new product decision is required; otherwise returns `REPLAN_DRAFT` and requires review.
