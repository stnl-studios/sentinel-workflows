# File Purpose Header

```yaml
purpose: Define regression expectations for optional task review.
status: not_applicable
read_when: Changing REVIEW_TASKS or task-fidelity validators.
do_not_read_when: Skipping the optional review or using stable contracts.
contains: Fidelity, coverage, isolation, allowed writes, and replan cases.
owner: stnl-task-reviewer
update_policy: Extend when task review misses a checklist defect.
```

# REVIEW_TASKS Eval Cases

1. Repairs missing or invented checklist work while preserving approved strategy.
2. Changes only global and detailed task artifacts.
3. Creates no persistent review profile or approval state.
4. Returns `NEEDS_REPLAN` rather than changing plans.
5. Accepts repeat review only while the exact materialized-pristine sentinels remain.
6. A marked task, developer check, Validation Attempt, or other operational evidence blocks and preserves bytes.
