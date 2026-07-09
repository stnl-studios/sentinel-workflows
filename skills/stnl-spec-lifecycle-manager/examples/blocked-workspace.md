# File Purpose Header

```yaml
purpose: Show the minimum workspace for an INIT blocked by an open question.
status: blocked
read_when: A concrete blocked INIT shape is needed.
do_not_read_when: A ready or closed SPEC example is needed.
contains: Minimal tree, feature document excerpt, and one question artifact.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with the workspace and question policies.
```

# Blocked Workspace

```text
specs/onboarding-improvements/
├── feature_spec.md
└── shared/
    └── questions.md
```

`feature_spec.md` records `spec_status: blocked`, the `questions.md` path, and `Q-001` as its blocker. No other category is materialized.

`questions.md` contains:

```yaml
id: Q-001
status: open
question: Which onboarding flow and user segment are in scope?
why_it_matters: It determines scope and acceptance criteria.
blocks: []
resolution: null
resolved_by: null
linked_decision: null
```
