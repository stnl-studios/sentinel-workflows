# File Purpose Header

```yaml
purpose: Define evaluation expectations for changes to the delivery workflow skill.
status: not_applicable
read_when: Updating the skill, templates, prompts, examples, or structural checks.
do_not_read_when: Running ordinary delivery work.
contains: Evaluation scope, quality categories, and regression signals.
owner: stnl-spec-execution-manager
update_policy: Expand when a real regression reveals a missing invariant.
```

# Eval Guidance

Use the named cases in `evals/eval-plan.md` before adopting a substantial change. Check requirements preservation, phase boundaries, selective reading, evidence quality, independent validation, safe parallelization, retention policies, headers on internal artifacts, header-free copyable prompts, and no mandatory provider or model.

Fail a change that silently changes requirements, completes a phase before validation, lets validation repair code, duplicates details in an index, lets workers update shared indices concurrently, reopens concluded work, or forces removal under `validate_only` or `consolidate_and_keep`.
