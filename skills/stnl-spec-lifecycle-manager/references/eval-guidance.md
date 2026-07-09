# File Purpose Header

```yaml
purpose: Define evaluation expectations for changes to the independent SPEC skill.
status: not_applicable
read_when: Updating the skill, templates, prompts, examples, or structural checks.
do_not_read_when: Running a normal SPEC lifecycle operation.
contains: Evaluation scope, quality categories, and regression signals.
owner: stnl-spec-lifecycle-manager
update_policy: Expand when a real regression reveals a missing invariant.
```

# Eval Guidance

Use the named cases in `evals/eval-cases.md` before adopting a substantial change. Check documentary outcomes, ID stability, selective reading, headers, cross-reference integrity, conservative review, and durable closure.

Fail a change that requires a delivery workflow, invents requirements, changes stable IDs, hides a relevant decision, mutates during `PLANNING`, makes closure depend on operational proof, duplicates artifacts, or leaves auxiliary SPEC files after successful CLOSE.
