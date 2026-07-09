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

## Failure signals

Fail a change that silently edits requirements, creates all detailed task records upfront, concludes a phase from checkboxes alone, lets validation correct files, lets workers update indices concurrently, reopens concluded work, or forces a closure policy not selected by the caller.
