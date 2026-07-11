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
6. `tasks.md` identifies slice eligibility from open status, concluded dependencies, and blocking divergences; it may present the first eligible slice only as a suggested next slice.
7. `EXECUTE_SLICE`, `VALIDATE_SLICE`, `APPLY_FINDINGS`, and `FINALIZE_SLICE` block without explicit `SLICE`, including when exactly one slice is eligible.
8. `PARALLELIZE_SLICES` blocks without explicit `SLICES` and never infers additional candidates.
9. A clean `EXECUTE_SLICE` session reads only global summaries, the selected plan, the selected task file, referenced requirements, and related code/tests.
10. Execution completes local tasks and records evidence but cannot conclude the global slice row.
11. Path references are relative to the artifact that contains them.
12. Validation is independent, read-only for code, and returns only `PASS` or `NEEDS_FIX`.
13. Findings are persisted with problem, evidence, impact, related reference, and expected correction.
14. `APPLY_FINDINGS` corrects only persisted findings and necessary effects.
15. After `APPLY_FINDINGS`, the same `VALIDATE_SLICE` operation runs again as revalidation and writes `Revalidação` without overwriting `Validação`.
16. `FINALIZE_SLICE` blocks without validation.
17. `FINALIZE_SLICE` blocks when findings lack corrections or revalidation.
18. A slice becomes `[x]` only with mandatory tasks, final test evidence, validation, required revalidation, and final diff summary.
19. A concluded slice is immutable; later work becomes a new corrective or complementary slice.
20. Executed tests require non-empty `Testes executados`, `Resultado dos testes: PASS`, and no `Justificativa sem teste`.
21. No-applicable-test evidence requires `Testes executados: nenhum`, `Resultado dos testes: not_applicable`, and a specific objective `Justificativa sem teste`.
22. Malformed, duplicated, inline-filled, or empty-item evidence lists fail structural validation.
23. Malformed divergence records fail structural validation and cannot make a slice eligible by default.
24. A material requirements, scope, dependency, or strategy change blocks affected work and returns to the requirements process.
25. Independent slices may run in parallel only with a recorded non-overlap justification.
26. Shared files, schemas, contracts, mutable state, generated code, global fixtures, or order dependency block parallel work.
27. Parallel execution does not update `tasks.md` concurrently.
28. The skill creates no commits, stores no commit hash, and has no commit operation.
29. `CLOSE` cross-checks requirements, execution artifacts, code, tests, findings, and evidence instead of trusting checkboxes.
30. `CLOSE` validates and reports only.
31. `CLOSE` does not modify requirements, lifecycle artifacts, execution artifacts, code, or files.
32. `CLOSE` has no artifact-retention, removal, or cleanup policy options.
33. A `feature_spec.md` source uses its separate `execution/` child without changing lifecycle artifacts.
34. A generic external source uses a sibling execution root with explicit relative references and is neither moved nor changed.
35. The skill has no mandatory provider, model, context-reset command, subagent, or particular requirements-producing skill.
36. `EXECUTE_SLICE` derives its source, execution root, selected plan, selected task file, requirements, and evidence from only `SPEC_PATH` and `SLICE`.
37. `VALIDATE_SLICE`, `APPLY_FINDINGS`, and `FINALIZE_SLICE` derive the same selected artifacts from the normalized source and slice.
38. `REVIEW_PLAN`, `MATERIALIZE_TASKS`, and `CLOSE` derive their execution root from `SPEC_PATH` without an execution-root input.
39. A SPEC workspace directory and its direct `feature_spec.md` path normalize to the same source and execution root.
40. A generic external requirements file remains unchanged and normalizes to its sibling requirements-name execution root.
41. `SLICE=3` and `SLICE=03` both normalize to `slice-03`; empty, signed, negative, non-numeric, decimal, and prefixed values block.
42. `SLICES` accepts only an explicit comma-separated numeric list, removes duplicates in order, requires two distinct normalized slices, and never discovers candidates.
43. Empty additional context is a no-op; valid context can restrict the selected operation without becoming persisted authority.
44. Additional context that materially conflicts with a requirements record or approved plan blocks, identifies the artifact or ID, and returns to `RESUME`, `REVIEW_PLAN`, or the applicable operation.
45. Negative launcher mutations reject noncanonical launcher structure, explicit execution-root input, and legacy optional placeholders.

## Failure signals

Fail a change that silently edits requirements, makes `plan.md` the progress authority, omits per-slice task files after task materialization, reads all slice details for one-slice execution, lets validation modify code, concludes from checkboxes alone, accepts `PASS` without real test evidence, accepts `not_applicable` without a specific reason, reopens concluded work, or lets closure copy execution content into the requirements source.
