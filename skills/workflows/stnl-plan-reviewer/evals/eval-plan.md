# File Purpose Header

```yaml
purpose: Define regression expectations for independent plan review.
status: not_applicable
read_when: Changing REVIEW_PLAN behavior or approval validators.
do_not_read_when: Performing an ordinary review with stable contracts.
contains: Coverage, correction, approval, and authority failure cases.
owner: stnl-plan-reviewer
update_policy: Extend when review fails to detect a material planning defect.
```

# REVIEW_PLAN Eval Cases

1. Reviews explicitly: Slice boundary, verticality, cohesion, independent outcomes, over-slicing, over-merging, artificial technical slicing, artificial Foundation, artificial Integration/Stabilization, coverage, dependencies, Serial Slice Order, and SPEC boundary.
2. Corrects missing coverage, overlap, semantic boundaries, order, dependencies, risks, tests, and explicit operational integration gaps.
3. Keeps one capability spanning frontend/backend/persistence/tests in one Slice when the milestone is one observable outcome.
4. Merges candidates separated only by technical layer, handoff, or first-behavior dependency; does not split for task/file count or agent/context limits.
5. Splits independent outcomes despite shared domain/theme, using lifecycle, contract, state, validation, risk, rollback, migration, cutover, rollout, compatibility, or dependency evidence.
6. Permits legitimate technical milestones such as migration, rollout, cutover, compatibility, security, performance/SLO, observability, certification, or load campaigns when independently observable.
7. Rejects a Foundation, Tests, Telemetry, generic Integration, Stabilization, Cleanup, Follow-up, or remaining-work Slice without an independent milestone; preserves legitimate cross-Slice operational integration.
8. Uses no ideal, maximum, minimum, target, or preferred Slice count and does not equate many requirements with many Slices.
9. Challenges a `MULTIPLE`/ambiguous SPEC boundary through existing requirements-refinement, lifecycle, roadmap, or `RESUME` authority rather than hiding it in a healthy-looking decomposition.
10. Preserves the union of requirements, acceptance criteria, decisions, constraints, risks, contracts, and other relevant obligations across split, merge, and reorder; never invents or silently transfers authority.
11. Recomputes the dependency graph after each transformation, rejects unknown/self/circular/future edges, and verifies downstream mappings and serial order.
12. Leaves every mutable initial/replacement plan or pending extension `ready` and approved without changing historical detailed plans.
13. Changes no tasks, code, or requirements.
14. Returns a lifecycle handoff when a documentary decision or SPEC boundary resolution is required.
15. Repeats safely while an initial, pristine replacement, or append-only recovery draft exists.
16. With prior operational history, approves only a pending increasing revision/extension and preserves every historical plan/task byte.
17. Rejects stale authority fingerprints, non-monotonic slices, invalid supersession, or authority change without a current-revision reconciliation/corrective or explicitly required operational milestone.
18. Reviews a planning-only replacement as revision `1` initial authority with no historical recovery fields, and rejects any obsolete detailed plan outside the global Serial Slice Order.
