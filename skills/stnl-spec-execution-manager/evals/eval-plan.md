# File Purpose Header

```yaml
purpose: Define regression cases for the conservative delivery workflow skill.
status: not_applicable
read_when: Changing the skill, templates, examples, or structural validation.
do_not_read_when: Running ordinary delivery work.
contains: Required execution eval cases and shared failure signals.
owner: stnl-spec-execution-manager
update_policy: Extend when a real regression exposes a missing invariant.
```

# Eval Plan

## Required cases

1. Initial planning creates the compact index and detailed plan for every foreseeable phase.
2. Self-critique splits or corrects an oversized phase before detailed tasks exist.
3. Planning detects and records a hidden dependency.
4. Only the next executable detailed task file is materialized.
5. A delivery session reads only the selected phase, linked requirements, and relevant code.
6. An executor completes individual tasks but cannot conclude the phase.
7. Validation is read-only and returns `PASS` or `NEEDS_FIX`.
8. Findings are corrected, tested, and revalidated before conclusion.
9. A phase becomes `[x]` only with tasks, tests, validation, and revalidation evidence.
10. A concluded phase is not reopened.
11. Later work becomes a new corrective phase.
12. Independent non-overlapping phases may proceed in parallel while indices are serialized.
13. Shared files, schemas, contracts, mutable state, or ordering dependencies block parallel work.
14. A requirements or scope change stops delivery and returns to the requirements owner.
15. Operational closure blocks when coverage, tests, evidence, or findings are incomplete.
16. Successful operational closure verifies final compatibility with the requirements source.
17. `validate_only` preserves the source and all delivery artifacts.
18. `consolidate_and_keep` retains delivery artifacts after allowed consolidation.
19. `consolidate_and_remove` removes delivery artifacts only after a successful explicit closure.
20. The skill has no mandatory provider, model, or particular SPEC-producing skill.
21. A `feature_spec.md` source uses its separate `execution/` child workspace without changing lifecycle artifacts.
22. A generic external source uses a sibling execution workspace with explicit relative references and is neither moved nor changed during planning.
23. A concluded phase with one executed test records `tests_executed` as a block list, `test_result: PASS`, no `test_reason`, and valid validation evidence.
24. A concluded phase with multiple executed tests preserves each test as a separate `tests_executed` item.
25. A concluded documentary phase with no applicable test records `tests_executed: []`, `test_result: not_applicable`, and a specific non-empty `test_reason`.
26. `test_result: PASS` with `tests_executed: []` fails conclusion.
27. `test_result: not_applicable` without a specific `test_reason` fails conclusion.
28. Malformed, duplicated, inline-filled, or empty-item `tests_executed` lists fail structural validation.
29. `tests_executed` and `corrections` are parsed as independent lists; items under one field never satisfy the other.
30. The validation-history matrix keeps using valid test evidence by default so it tests only `validation`, `corrections`, and `revalidation`.
31. Approval after correction preserves `validation: NEEDS_FIX`, non-empty `corrections`, `revalidation: PASS`, and valid test evidence.

## Failure signals

Fail a change that silently edits requirements, creates all detailed task records upfront, concludes a phase from checkboxes alone, lets `PASS` conclude without a recorded test, lets `not_applicable` conclude without a specific reason, lets validation correct files, lets workers update indices concurrently, reopens concluded work, or forces a closure policy not selected by the caller.
