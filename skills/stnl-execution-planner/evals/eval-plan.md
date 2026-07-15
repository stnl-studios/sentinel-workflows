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

# PLAN Eval Cases

1. Creates only global and detailed plan artifacts with `draft` headers and pending review state.
2. Preserves the requirements source and relative paths.
3. Covers every requirement with serial, observable, testable slices and explicit dependencies.
4. Adds a final integration slice when cross-slice verification is a real delivery requirement.
5. Rejects ambiguous requirements instead of inventing product decisions.
6. Runs only from `empty`; existing plans, tasks, or unrelated content block without byte changes.
7. Never describes PLAN as replacement or reset.
