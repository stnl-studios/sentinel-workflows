# File Purpose Header

```yaml
purpose: Define regression cases for the slice-based execution workflow skill.
status: not_applicable
read_when: Changing the skill, templates, examples, prompts, or structural validation.
do_not_read_when: Running ordinary slice execution work.
contains: Required execution eval cases and shared failure signals.
owner: stnl-spec-execution-manager
update_policy: Extend when a real regression exposes a missing invariant.
```

# Eval Plan

## Required cases

1. `PLAN` creates `plan.md` plus `plans/slice-NN.md` for every foreseeable slice and creates no tasks.
2. `REVIEW_PLAN` corrects oversized slices, hidden dependencies, missing coverage, migrations, integrations, breaking changes, shared state, order, testability, and unsafe parallel claims without implementing.
3. `MATERIALIZE_TASKS` creates `tasks.md` plus every `tasks/slice-NN.md` from the reviewed plans.
4. `plan.md` contains useful global summaries and detailed plan paths, not only links and not completion checkboxes.
5. `tasks.md` is the only global authority for `[ ]` and `[x]`.
6. The current slice is the first open row whose dependencies are concluded and whose detailed task file has no blocking divergence.
7. Multiple eligible independent slices require explicit slice selection.
8. A clean `EXECUTE_SLICE` session reads only global summaries, the selected plan, the selected task file, referenced requirements, and related code/tests.
9. Execution completes local tasks and records evidence but cannot conclude the global slice row.
10. Path references are relative to the artifact that contains them.
11. Validation is independent, read-only for code, and returns only `PASS` or `NEEDS_FIX`.
12. Findings are persisted with problem, evidence, impact, related reference, and expected correction.
13. `APPLY_FINDINGS` corrects only persisted findings and necessary effects.
14. `FINALIZE_SLICE` blocks without validation.
15. `FINALIZE_SLICE` blocks when findings lack corrections or revalidation.
16. A slice becomes `[x]` only with mandatory tasks, final test evidence, validation, required revalidation, and final diff summary.
17. A concluded slice is immutable; later work becomes a new corrective or complementary slice.
18. Executed tests require non-empty `tests_executed`, `test_result: PASS`, and no `test_reason`.
19. No-applicable-test evidence requires `tests_executed: []`, `test_result: not_applicable`, and a specific objective `test_reason`.
20. Malformed, duplicated, inline-filled, or empty-item evidence lists fail structural validation.
21. A material requirements, scope, dependency, or strategy change blocks affected work and returns to the requirements process.
22. Independent slices may run in parallel only with a recorded non-overlap justification.
23. Shared files, schemas, contracts, mutable state, generated code, global fixtures, or order dependency block parallel work.
24. Parallel execution does not update `tasks.md` concurrently and does not create commits automatically.
25. `COMMIT_SLICE` is a formal optional operation, stages only finalized slice changes, and may append only commit metadata after conclusion.
26. `CLOSE` cross-checks requirements, execution artifacts, code, tests, findings, and evidence instead of trusting checkboxes.
27. `CLOSE` does not modify the requirements source.
28. `validate_only` preserves the source and execution artifacts.
29. `validate_and_remove` removes only execution artifacts and only after explicit request plus successful validation.
30. A `feature_spec.md` source uses its separate `execution/` child without changing lifecycle artifacts.
31. A generic external source uses a sibling execution root with explicit relative references and is neither moved nor changed.
32. The skill has no mandatory provider, model, context-reset command, subagent, commit policy, or particular requirements-producing skill.

## Failure signals

Fail a change that silently edits requirements, makes `plan.md` the progress authority, omits per-slice task files after task materialization, reads all slice details for one-slice execution, lets validation modify code, concludes from checkboxes alone, accepts `PASS` without real test evidence, accepts `not_applicable` without a specific reason, reopens concluded work, or lets closure copy execution content into the requirements source.
