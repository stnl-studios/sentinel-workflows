# File Purpose Header

```yaml
purpose: Demonstrate minimum reads for executing and validating one selected slice.
status: ready
read_when: An execution session or validator needs a concrete selective-reading sequence.
do_not_read_when: The task is only about workspace setup, source preservation, or closure policy.
contains: Execution and validation read sets for one slice without opening unrelated slice details.
owner: stnl-spec-execution-manager
update_policy: Keep aligned with token economy and slice execution contracts.
```

# Selective Reading

For slice 02 in the workspace example:

1. Read `execution/plan.md` for global context and source location.
2. Read `execution/tasks.md` to confirm slice 02 is open and dependencies are concluded.
3. Read `execution/plans/slice-02.md`.
4. Read `execution/tasks/slice-02.md`.
5. Read only the requirements records referenced by slice 02.
6. Read only code and tests related to the expected areas or newly discovered concrete dependencies.

Do not open `plans/slice-01.md`, `tasks/slice-01.md`, `plans/slice-03.md`, or `tasks/slice-03.md` during slice 02 execution unless a concrete dependency or conflict is discovered and recorded.

For validation, replace broad exploration with the selected diff, recorded test evidence, changed code, and dependencies needed to verify that diff. The validator returns only `PASS` or `NEEDS_FIX` and changes no code.
