# File Purpose Header

```yaml
purpose: Define evaluation expectations for changes to the slice execution workflow skill.
status: not_applicable
read_when: Updating the skill, templates, prompts, examples, or structural checks.
do_not_read_when: Running ordinary slice execution work.
contains: Evaluation scope, quality categories, and regression signals.
owner: stnl-spec-execution-manager
update_policy: Expand when a real regression reveals a missing invariant.
```

# Eval Guidance

Use the named cases in `evals/eval-plan.md` before adopting a substantial change. Check requirements preservation, slice boundaries, upfront task materialization, deterministic current-slice selection, relative paths, selective reading, evidence quality, independent validation, safe parallelization, closure boundaries, headers on internal artifacts, and absence of mandatory provider or model.

Fail a change that silently edits requirements, stores progress in `plan.md`, omits detailed task files after `MATERIALIZE_TASKS`, completes a slice before validation, lets validation repair code, duplicates detailed content in global artifacts, updates `tasks.md` concurrently during parallel work, reopens concluded work, or makes closure modify the requirements source.
