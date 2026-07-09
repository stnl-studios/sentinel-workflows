# File Purpose Header

```yaml
purpose: Show a ready modular workspace with one executable slice.
status: example
read_when: The agent needs a concrete slice-driven workspace example.
do_not_read_when: Only a blocked INIT or CLOSE example is needed.
contains: File tree and compact excerpts showing cross references without duplicated artifact prose.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with references/spec-workspace.md.
```

# Slice-Driven Workspace Example

## Tree

```text
specs/invitation-expiration/
├── feature_spec.md
├── shared/
│   ├── acceptance-criteria.md
│   ├── decisions.md
│   ├── constraints.md
│   └── risks.md
├── slices/
│   └── SL-001.md
└── lifecycle/
    ├── traceability.md
    ├── qa-checklist.md
    └── resume-notes.md
```

## `feature_spec.md`

~~~markdown
# Invitation Expiration - Feature Spec Index

## Spec Metadata

```yaml
spec_id: invitation-expiration
workspace_root: specs/invitation-expiration
spec_status: ready
created_from_mode: INIT
last_updated_mode: PLANNING
current_slice: null
next_candidate_slice: SL-001
open_question_count: 0
```

## Objective

Allow invitations to expire after a configured expiration timestamp so stale invitations cannot be accepted indefinitely.

## Artifact Index

```yaml
artifacts:
  acceptance_criteria: {file: shared/acceptance-criteria.md, count: 2, materialized: true}
  decisions: {file: shared/decisions.md, count: 1, materialized: true}
  constraints: {file: shared/constraints.md, count: 1, materialized: true}
  risks: {file: shared/risks.md, count: 1, materialized: true}
  questions: {file: null, count: 0, open_count: 0, materialized: false}
  slices:
    - {id: SL-001, file: slices/SL-001.md, status: ready}
```
~~~

## Shared Artifacts

`shared/acceptance-criteria.md`:

~~~markdown
### AC-001 - Expired invitation cannot be accepted

```yaml
id: AC-001
status: active
statement: An invitation with an expiration timestamp in the past cannot be accepted.
linked_slices: [SL-001]
```

### AC-002 - Expiration is observable in lookup

```yaml
id: AC-002
status: active
statement: Invitation lookup exposes whether the invitation is expired while preserving existing fields.
linked_slices: [SL-001]
```
~~~

`shared/decisions.md`:

~~~markdown
### D-001 - Preserve existing invitation lookup contract

```yaml
id: D-001
status: accepted
decision: Add expiration status without removing existing response fields.
linked_artifacts: [AC-002, C-001, SL-001]
```
~~~

`shared/constraints.md`:

~~~markdown
### C-001 - Preserve public response compatibility

```yaml
id: C-001
status: active
constraint: Do not remove or rename existing invitation lookup response fields.
linked_artifacts: [D-001, AC-002, SL-001]
```
~~~

`shared/risks.md`:

~~~markdown
### R-001 - Time comparison inconsistency

```yaml
id: R-001
status: open
risk: Expiration behavior may be inconsistent if time comparison uses mixed timezone assumptions.
impact: medium
mitigation: Use the system's existing time handling convention.
linked_artifacts: [SL-001]
```
~~~

## `slices/SL-001.md`

~~~markdown
# SL-001 - Enforce invitation expiration

```yaml
id: SL-001
status: ready
goal: Prevent expired invitations from being accepted while exposing expiration state in lookup.
scope: Store/use expiration timestamp, enforce acceptance blocking, and expose expiration status.
out_of_scope: Admin UI, notifications, email-template changes.
linked_acceptance_criteria: [AC-001, AC-002]
linked_decisions: [D-001]
linked_constraints: [C-001]
linked_risks: [R-001]
linked_questions: []
dependencies: []
validation_hints:
  - Expired invitations must be observably rejected by the existing acceptance flow.
  - Invitation lookup must preserve existing fields while exposing expiration state.
context_hints:
  - invitation domain/model
  - invitation acceptance flow
  - invitation lookup endpoint or service
slice_readiness:
  status: ready
  blockers: []
  missing: []
completion_summary: null
```
~~~

The slice links IDs only. It does not duplicate the full text of ACs, constraints, risks, or decisions.

## Lifecycle

`lifecycle/traceability.md`:

| Slice | Slice file | ACs | Constraints | Risks | Decisions | Questions |
|---|---|---|---|---|---|---|
| `SL-001` | `slices/SL-001.md` | `AC-001`, `AC-002` | `C-001` | `R-001` | `D-001` | - |

`lifecycle/resume-notes.md` points `next_candidate_slice` to `SL-001` and lists only linked IDs to load next.
