# File Purpose Header

```yaml
purpose: Show a minimal modular workspace blocked by an open question.
status: example
read_when: The agent needs a concrete INIT-blocked example.
do_not_read_when: A ready slice-driven example is needed instead.
contains: File tree and compact file excerpts for a blocked workspace.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with references/spec-workspace.md.
```

# Blocked Workspace Example

## Tree

```text
specs/onboarding-improvements/
├── feature_spec.md
├── shared/
│   └── questions.md
└── lifecycle/
    ├── traceability.md
    ├── qa-checklist.md
    └── resume-notes.md
```

No slice file is created because there is not enough signal to define an executable slice.

## `feature_spec.md`

~~~markdown
# File Purpose Header

```yaml
purpose: Index for onboarding improvements spec workspace.
status: blocked
read_when: Discovering workspace state, blockers, or next files to load.
do_not_read_when: A prepared slice package already contains all required context.
contains: Compact metadata, objective, artifact index, blockers, and selective reading instructions.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME update index metadata; CLOSE replaces with final spec.
```

# Onboarding Improvements - Feature Spec Index

## Spec Metadata

```yaml
spec_id: onboarding-improvements
workspace_root: specs/onboarding-improvements
spec_status: blocked
created_from_mode: INIT
last_updated_mode: INIT
current_slice: null
next_candidate_slice: null
open_question_count: 1
```

## Objective

Improve onboarding, pending clarification of target user, workflow, and success behavior.

## Artifact Index

```yaml
artifacts:
  acceptance_criteria: {file: null, count: 0, materialized: false}
  decisions: {file: null, count: 0, materialized: false}
  constraints: {file: null, count: 0, materialized: false}
  risks: {file: null, count: 0, materialized: false}
  questions: {file: shared/questions.md, count: 1, open_count: 1, materialized: true}
  slices: []
```

## Blockers

```yaml
open_questions: [Q-001]
broken_references: []
readiness_blockers: [Q-001]
```
~~~

## `shared/questions.md`

~~~markdown
# File Purpose Header

```yaml
purpose: Store onboarding improvements questions.
status: blocked
read_when: INIT, RESUME, or PLANNING checks open blockers.
do_not_read_when: The index reports no open questions.
contains: Q-### artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME may update; execution agents cannot bypass questions.
```

# Questions

### Q-001 - Which onboarding flow is in scope?

```yaml
id: Q-001
status: open
question: Which user segment and onboarding flow should this spec govern?
why_it_matters: Determines acceptance criteria, slice boundaries, and scope.
blocks: []
resolution: null
resolved_by: null
linked_decision: null
```
~~~

## Lifecycle Files

`lifecycle/traceability.md` contains no rows and records that no slices exist yet.
`lifecycle/qa-checklist.md` is blocked by `Q-001`.
`lifecycle/resume-notes.md` points to `shared/questions.md` as the next file to load.
