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
2. Leaves every global and detailed planning artifact `ready` and approved.
3. Changes no tasks, code, or requirements.
4. Returns a lifecycle handoff when a documentary decision is required.
5. Repeats safely while state is `planned` and blocks after any task artifact exists.
6. Preserves planning artifacts byte-for-byte when invoked after materialization.
