# File Purpose Header

```yaml
purpose: Demonstrate minimum reads for delivering and validating a selected phase.
status: ready
read_when: A delivery session or validator needs a concrete selective-reading sequence.
do_not_read_when: The task is only about workspace setup or operational closure.
contains: Delivery and validation read sets for one phase.
owner: stnl-spec-execution-manager
update_policy: Keep aligned with token economy and phase execution contracts.
```

# Selective Reading

For phase 02:

1. Read the named requirements source for scope and criteria.
2. Read `plans/plan-02.md` and `tasks/tasks-02.md`.
3. Locate only the requirements records named in those files.
4. Read only code and tests related to phase 02.
5. Use `plan.md` and `tasks.md` only to confirm order or continuity.
6. Do not load other detailed plans, prior tasks, all source records, or repository-wide context without a direct need.

For validation, replace source exploration with the selected diff and recorded test evidence. The validator returns `PASS` or `NEEDS_FIX` and changes no files.
