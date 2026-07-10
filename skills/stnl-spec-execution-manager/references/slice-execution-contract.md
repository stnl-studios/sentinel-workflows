# File Purpose Header

```yaml
purpose: Define evidence-preserving execution, independent validation, correction, and finalization of one slice.
status: not_applicable
read_when: Executing, validating, correcting, or finalizing a materialized slice.
do_not_read_when: Creating initial plans or reviewing an unrelated slice.
contains: Minimum reads, permitted updates, test evidence, verdicts, correction rules, and finalization protocol.
owner: stnl-spec-execution-manager
update_policy: Change only when slice evidence or validation boundaries change.
```

# Slice Execution Contract

## Execute

Read `plan.md`, `tasks.md`, the selected `plans/slice-NN.md`, the selected `tasks/slice-NN.md`, referenced requirements, explicitly named files, required imports, related tests, and additional files only when a concrete need appears. Do not load unrelated detailed plans, unrelated detailed task files, all source records, previous session summaries, or the whole repository by default.

The executor may implement scoped work, run relevant tests, complete local checklist items, record actual changed areas, record scope expansion, and persist concise evidence. It must not mark the global slice row `[x]`.

## Test Evidence

A finalized slice accepts only final test evidence:

- `tests_executed` is a YAML block list of commands, suites, or observable checks, or `[]` when no test applies.
- `test_result` is `PASS` when tests ran successfully, or `not_applicable` only when no executable or observable test applies.
- `test_reason` is required only with `not_applicable` and must be objective and specific.

Do not store full command output, discarded attempts, transcript fragments, or internal reasoning.

## Validate

Validation is independent and read-only for code. Compare the selected diff with the selected plan, selected tasks, referenced requirements, and test evidence. Return and persist exactly one verdict:

- `PASS`
- `NEEDS_FIX`

Each finding includes problem, evidence, impact, related requirement/plan/task, and expected correction. Validation does not implement corrections, update `tasks.md`, finalize the slice, or create commits.

If `validation` is pending, write the verdict to `validation`. If `validation` is `NEEDS_FIX`, corrections are recorded, and `revalidation` is pending, write the focused verdict to `revalidation`. Do not overwrite the initial validation history. Block incompatible states such as revalidation without recorded corrections, corrections after initial `PASS`, or an attempt to replace an existing verdict.

## Apply Findings

Corrections are limited to persisted findings and necessary effects. Rerun affected tests and record corrections. Do not perform opportunistic refactors.

If a correction requires a material requirements, scope, dependency, or strategy change, stop the affected work, record the divergence in the selected task file, and return the issue to the requirements process.

## Finalize

Finalization implements no new functionality. It verifies checklist, evidence, validation, findings, corrections, revalidation, diff summary, and scope boundaries.

For initial validation `PASS`, record `revalidation: not_required`. For initial validation `NEEDS_FIX`, require non-empty corrections and independent focused revalidation with `PASS`.

Only then finalize `tasks/slice-NN.md`, mark the selected row `[x]` in `tasks.md`, record a short result, and stop. Do not start another slice, materialize new files, alter requirements, or create a commit unless a separate operation requests it.

## Commit

Committing a slice is a separate optional operation after finalization. Stage only files belonging to the finalized slice and do not alter implementation. Functional content and evidence are immutable after conclusion; commit hash or equivalent operational metadata may be appended to `tasks/slice-NN.md` when the artifact supports it, but tasks, tests, findings, corrections, validation, revalidation, and final result must not be rewritten.

## Parallelize

Parallel execution requires explicit slice numbers and a concrete non-overlap check. Shared files, schemas, contracts, fixtures, generated code, persistent state, mutable external resources, or order dependencies block parallel work. Approved executions update only their own detailed task files and related implementation files; `tasks.md` is updated later in serial finalization.
