# File Purpose Header

```yaml
purpose: Define phase planning, binary completion, task materialization, and safe parallelization.
status: not_applicable
read_when: Creating or revising plans, tasks, phase boundaries, or parallel work.
do_not_read_when: Only a selected task or validation finding is being handled.
contains: Phase responsibilities, sizing rules, task sequencing, completion rules, and parallel limits.
owner: stnl-spec-execution-manager
update_policy: Change when the delivery phase model changes.
```

# Phase Model

A phase delivers one observable and testable outcome. It is neither a microtask nor a bundle of unrelated deliveries. It must have coherent scope, an explicit dependency position, and a result that can be assessed independently of a particular workflow tool.

The only phase state is its checkbox in `plan.md` and `tasks.md`:

- `[ ]` not concluded;
- `[x]` concluded.

Use `plans/plan-01.md` for the detailed plan and `tasks/tasks-01.md` for the detailed record. Their zero-padded sequences match. Do not create a separate canonical phase ID.

## Planning and tasks

Initial planning creates detailed plans for every foreseeable phase, then critiques size, requirements coverage, dependencies, risks, order, assumptions, migration needs, breaking changes, shared state, testability, and parallel safety. Correct the plan before creating task records.

Materialize `tasks.md` and only the next executable task file. Materialize later task files after the preceding phase concludes, unless explicit parallel safety permits otherwise. Each detailed task uses a local number, expected areas, acceptance reference, and expected tests. It records actual changed areas, tests, findings, corrections, revalidation, concise diff summary, and final result.

## Conclusion

Mark a phase `[x]` only after all required tasks are complete, relevant tests pass, independent validation returns `PASS`, every blocking finding is corrected, and focused revalidation passes. Then update both indices and materialize the next safe task file. Never reopen a concluded phase; add a new numbered corrective or complementary phase instead.

## Parallel work

Mark phases parallelizable only when they share no files, schemas, migrations, lockfiles, contracts, global fixtures, generated code, persistent state, common resources, order dependency, or tests that mutate shared resources.

Parallel workers read only their own detailed plan, detailed tasks, linked requirements records, and relevant code. They update only their own `tasks/tasks-NN.md`. A coordinator serially integrates results and updates `plan.md` and `tasks.md`.
