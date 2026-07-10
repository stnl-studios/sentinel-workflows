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
14. After `APPLY_FINDINGS`, the same `VALIDATE_SLICE` operation runs again as revalidation and writes `Revalidação` without overwriting `Validação`.
15. `FINALIZE_SLICE` blocks without validation.
16. `FINALIZE_SLICE` blocks when findings lack corrections or revalidation.
17. A slice becomes `[x]` only with mandatory tasks, final test evidence, validation, required revalidation, and final diff summary.
18. A concluded slice is immutable; later work becomes a new corrective or complementary slice.
19. Executed tests require non-empty `Testes executados`, `Resultado dos testes: PASS`, and no `Justificativa sem teste`.
20. No-applicable-test evidence requires `Testes executados: nenhum`, `Resultado dos testes: not_applicable`, and a specific objective `Justificativa sem teste`.
21. Malformed, duplicated, inline-filled, or empty-item evidence lists fail structural validation.
22. Malformed divergence records fail structural validation and cannot make a slice eligible by default.
23. A material requirements, scope, dependency, or strategy change blocks affected work and returns to the requirements process.
24. Independent slices may run in parallel only with a recorded non-overlap justification.
25. Shared files, schemas, contracts, mutable state, generated code, global fixtures, or order dependency block parallel work.
26. Parallel execution does not update `tasks.md` concurrently.
27. The skill creates no commits, stores no commit hash, and has no commit operation.
28. `CLOSE` cross-checks requirements, execution artifacts, code, tests, findings, and evidence instead of trusting checkboxes.
29. `CLOSE` validates and reports only.
30. `CLOSE` does not modify requirements, lifecycle artifacts, execution artifacts, code, or files.
31. `CLOSE` has no artifact-retention, removal, or cleanup policy options.
32. A `feature_spec.md` source uses its separate `execution/` child without changing lifecycle artifacts.
33. A generic external source uses a sibling execution root with explicit relative references and is neither moved nor changed.
34. The skill has no mandatory provider, model, context-reset command, subagent, or particular requirements-producing skill.

## Failure signals

Fail a change that silently edits requirements, makes `plan.md` the progress authority, omits per-slice task files after task materialization, reads all slice details for one-slice execution, lets validation modify code, concludes from checkboxes alone, accepts `PASS` without real test evidence, accepts `not_applicable` without a specific reason, reopens concluded work, or lets closure copy execution content into the requirements source.
