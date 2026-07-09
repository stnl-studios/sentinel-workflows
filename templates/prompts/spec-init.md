# File Purpose Header

```yaml
purpose: Prompt template for starting or maturing an independent feature SPEC.
status: ready
read_when: A user needs MODE INIT.
do_not_read_when: An existing SPEC needs resumption, review, or documentary closure.
contains: Minimal input slots and INIT boundaries.
owner: stnl-spec-lifecycle-manager
update_policy: Update when INIT behavior changes.
```

Use stnl-spec-lifecycle-manager.
MODE=INIT

Feature intent: <problem, change, or outcome>
Known scope: <included and excluded behavior>
Known facts: <rules, decisions, constraints, risks, contracts>

Create `feature_spec.md` and only meaningful shared categories. Record the smallest blocking questions. Distinguish facts, hypotheses, and decisions; preserve stable IDs; do not invent requirements. Do not implement code or create delivery artifacts.
