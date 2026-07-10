# File Purpose Header

```yaml
purpose: Define slice planning, task materialization, binary progress, current-slice selection, and safe parallelization.
status: not_applicable
read_when: Creating or revising plans, tasks, slice boundaries, current-slice selection, or optional parallel work.
do_not_read_when: Only a selected validation finding is being corrected.
contains: Slice responsibilities, sizing rules, materialization rules, completion rules, and parallel limits.
owner: stnl-spec-execution-manager
update_policy: Change when the slice execution model changes.
```

# Slice Model

A slice delivers one observable and testable outcome. It is larger than a microtask, smaller than a broad initiative, coherent enough to validate in isolation, and suitable for a dedicated commit when the user asks for one.

Use zero-padded sequence numbers:

- `plans/slice-01.md`
- `tasks/slice-01.md`

Do not create a separate canonical ID when the sequence already identifies the slice inside the execution root.

## Planning

Planning creates `plan.md` and all foreseeable detailed plans. Each `plans/slice-NN.md` states objective, observable result, exact requirements references, included and excluded scope, boundaries with other slices, likely areas, dependencies, risks, strategy, expected tests, ready criterion, and parallelization assessment.

`plan.md` stays compact. It preserves enough global context for a clean session to choose or understand a slice without rereading all detailed plans, but it does not store checklists, extensive evidence, implementation history, or duplicated requirement text.

## Task Materialization

After plan review, materialize `tasks.md` and every `tasks/slice-NN.md`. This is intentional: each later clean execution session can read only the global summary plus its selected slice files.

`tasks.md` has exactly one global row per slice and is the canonical progress authority. Use only:

- `[ ]`: slice not concluded;
- `[x]`: slice concluded.

The detailed task file for each slice contains local checklist items, expected areas, acceptance references, expected tests, actual changed areas, scope expansion, test evidence, validation findings, corrections, revalidation, diff summary, final result, and optional commit.

## Current Slice

When a caller does not specify a slice, select the first row in `tasks.md` that:

- is `[ ]`;
- has all listed dependencies `[x]`;
- does not have a blocking divergence recorded in its detailed task file.

If multiple rows are eligible because they are genuinely independent, the operation must receive explicit slice numbers. Do not infer a parallel batch from a boolean flag.

## Completion

A slice can become `[x]` in `tasks.md` only after:

- every mandatory local task is complete;
- test evidence is final;
- independent validation returned `PASS`, or returned `NEEDS_FIX` followed by corrections and independent revalidation with `PASS`;
- all blocking findings are corrected;
- minimum evidence is persisted in `tasks/slice-NN.md`;
- the final diff excludes deliberate work reserved for other slices.

With executed tests, `tests_executed` lists at least one command, suite, or observable check and `test_result: PASS`. With no applicable test, `tests_executed: []`, `test_result: not_applicable`, and one objective `test_reason` are required. Pending, failed, malformed, contradictory, or generic evidence cannot conclude a slice.

A concluded slice is immutable. Later changes become a new corrective or complementary slice.

## Parallelization

Parallelization is optional. Two slices can run in parallel only when they share no files, schemas, migrations, lockfiles, public contracts, global fixtures, generated code, persistent state, mutable external resources, order dependency, or tests that mutate the same resource.

`parallelizable: true` is not enough. The detailed plans must record a concrete non-overlap justification. Parallel executions read only their own selected artifacts, update only their own detailed task files, do not update `tasks.md` concurrently, and do not create commits automatically. Results are integrated serially.
