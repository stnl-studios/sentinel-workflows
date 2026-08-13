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

1. Corrects missing coverage, overlap, sizing, order, dependencies, risks, tests, and integration gaps.
2. Leaves every mutable initial/replacement plan or pending extension `ready` and approved without changing historical detailed plans.
3. Changes no tasks, code, or requirements.
4. Returns a lifecycle handoff when a documentary decision is required.
5. Repeats safely while an initial, pristine replacement, or append-only recovery draft exists.
6. With prior operational history, approves only a pending increasing revision/extension and preserves every historical plan/task byte.
7. Rejects stale authority fingerprints, non-monotonic slices, invalid supersession, or authority change without a current-revision reconciliation/corrective slice.
