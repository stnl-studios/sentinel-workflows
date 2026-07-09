# File Purpose Header

```yaml
purpose: Define regression cases for the independent feature SPEC lifecycle.
status: not_applicable
read_when: Changing the skill, templates, examples, or structural validation.
do_not_read_when: Running an ordinary SPEC lifecycle operation.
contains: Required SPEC-only eval cases and shared failure signals.
owner: stnl-spec-lifecycle-manager
update_policy: Extend when a real regression exposes a missing invariant.
```

# Eval Cases

## Required cases

1. INIT with sufficient information creates `feature_spec.md` and only meaningful canonical artifacts.
2. INIT blocked by a question creates the minimum blocked workspace.
3. Existing Q, D, AC, R, and C IDs remain stable and new IDs do not fill gaps.
4. RESUME resolves a question through an explicit answer or decision.
5. RESUME preserves relevant decisions and makes changes visible.
6. PLANNING returns `READY` for a documentary-ready SPEC.
7. PLANNING returns `NEEDS_RESUME` with actionable findings for a deficient SPEC.
8. PLANNING creates no implementation planning artifacts and changes no SPEC files.
9. Selective reading loads only the feature document, selected category, and linked IDs.
10. A missing canonical reference fails `reference_integrity_gate`.
11. A non-observable acceptance criterion fails `acceptance_criteria_gate`.
12. Contradictory shared artifacts fail `decision_consistency_gate`.
13. CLOSE blocks on an unresolved question, invalid reference, or documentary contradiction.
14. Successful CLOSE produces one durable `feature_spec.md`.
15. Successful CLOSE leaves no `shared/` residue.
16. The skill has no dependency on agents, workers, or a fixed delivery pipeline.
17. The skill has no dependency on operational planning or task artifacts.

## Failure signals

Fail a change that invents requirements, makes a review mutate the workspace, requires delivery evidence for documentary closure, duplicates canonical content, changes a valid ID, leaves a broken reference, or retains auxiliary files after successful CLOSE.
