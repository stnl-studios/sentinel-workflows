# File Purpose Header

```yaml
purpose: Define regression expectations for PLAN.
status: not_applicable
read_when: Changing planner behavior, planning templates, or structural validators.
do_not_read_when: Running ordinary planning with stable contracts.
contains: PLAN success and failure cases.
owner: stnl-execution-planner
update_policy: Extend when a planner regression reveals a missing invariant.
```

# PLAN and REPLAN Eval Cases

1. Creates only global and detailed plan artifacts with `draft` headers and pending review state.
2. Preserves the requirements source and relative paths.
3. Uses the smallest cohesive, observable, validatable outcome/milestone as the Slice unit; Business, UX/Design, Architecture, and Engineering are completeness lenses, not persisted fields.
4. A small/unitary SPEC with one capability is allowed and remains one Slice; no penalty, minimum, maximum, target, or preferred Slice count is introduced.
5. A vertical capability spanning frontend, backend, API, persistence/database, tests, telemetry, and security remains one Slice when it has one outcome.
6. Rejects frontend/backend, API/persistence, or tests/telemetry separation when no independently observable milestone exists.
7. Splits multiple independent outcomes despite thematic affinity when lifecycle, contracts, state, validation, risk, rollback, migration, or delivery dependencies are materially independent.
8. Does not split a single outcome because it has many requirements, Tasks, files, technical layers, complexity, or an agent/context limit.
9. Permits multiple Slices for a migration, expand/migrate/contract, cutover, rollout, compatibility transition, or other real intermediate operational state.
10. Keeps shared primitives with the first real consumer and rejects an artificial Foundation Slice without its own milestone.
11. Keeps tests, telemetry, and ordinary integration in the owning Slice; allows a separate Integration/Stabilization Slice only for explicit independent cross-Slice behavior or an operational milestone that cannot be validated earlier.
12. Allows security hardening, performance/SLO, observability, certification, load, and compatibility Slices when that is the SPEC's independent objective, while rejecting technical slicing by convenience.
13. Challenges a SPEC boundary assessed as `MULTIPLE`, `AMBIGUOUS`, or otherwise containing independent product capabilities through the existing requirements/lifecycle/roadmap handoff instead of hiding it in many Slices.
14. Covers every active canonical acceptance criterion or requirement with serial, observable, testable Slices and explicit dependencies.
15. Recomputes dependencies after split, merge, or reorder, rejects unknown/self/circular edges, and keeps every dependency earlier in Serial Slice Order.
16. Preserves coverage for requirements, acceptance criteria, decisions, constraints, risks, contracts, and other relevant authority when Slices are split, merged, or reordered; no obligation is invented or dropped.
17. Adds an explicit cross-Slice operational milestone only when the approved requirements make it independently necessary; never adds a generic final integration, cleanup, follow-up, or stabilization deposit.
18. Rejects ambiguous requirements instead of inventing product decisions.
19. Runs only from `EMPTY`; existing plans, tasks, or unrelated content block without byte changes.
20. Never describes PLAN as replacement or reset.
21. Requires explicit `REPLAN_REASON` and derives pristine replacement versus append-only extension only from deterministic state.
22. Before tasks exist, atomically replaces the complete current planning authority, removes obsolete detailed plans, remains revision `1`, omits historical recovery fields, and returns through review plus initial materialization.
23. Replaces a wholly pristine canonical materialized plan/task set atomically under an increasing `pristine-replacement` revision, with no operational history loss.
24. After execution starts, preserves all history and appends monotonically numbered corrective, replacement, reconciliation, or explicitly required operational milestone Slices under an increasing plan revision.
25. Detects requirements fingerprint changes before materialization, after materialization, during partial execution, and after all prior Slices PASS; never treats stale plans as current.
26. Returns lifecycle `RESUME` without drafting when a new product decision or SPEC-boundary resolution is required; otherwise returns `REPLAN_DRAFT` and requires review.
