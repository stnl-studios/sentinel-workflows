# File Purpose Header

```yaml
purpose: Define gates used to decide whether a spec or slice may proceed.
load_when: Running PLANNING, validating RESUME output, or checking slice readiness.
do_not_load_when: Only creating initial draft text without readiness claims.
contains: Workspace, question, size, traceability, readiness, planning, closure, and ID gates.
owner: stnl-spec-lifecycle-manager
update_policy: Change when gate logic changes.
```

# Readiness Gates

Gates are deterministic checks used before execution or closure.

## Gate verdicts

Use these verdicts:

- `pass`
- `fail`
- `blocked`
- `needs_resume_replan`
- `not_applicable`

## `canonical_id_gate`

### Pass when

- every canonical artifact uses an allowed ID format;
- every artifact has ID in heading and `id:` field;
- existing IDs are preserved;
- references use IDs.
- every slice filename, heading, and `id:` field match.

### Fail when

- any invalid format appears;
- an ID was renumbered;
- an ID was reused;
- an artifact is referenced only by title.
- `slices/SL-001.md` declares a different ID.

### Failure action

Block. Invalid IDs indicate a contract violation, even when migrating a previous monolithic operational spec.

## `workspace_gate`

### Pass when

- operational `feature_spec.md` is a compact index, not a monolithic spec;
- required lifecycle files exist;
- materialized shared files exist at indexed paths;
- absent shared categories are explicitly marked as not materialized;
- each indexed slice file exists;
- no permanent slice context package exists.

### Fail when

- the operational workspace contains only a monolithic `feature_spec.md`;
- `feature_spec.md` includes complete slice definitions or complete shared artifacts;
- `lifecycle/traceability.md`, `lifecycle/qa-checklist.md`, or `lifecycle/resume-notes.md` is missing;
- an indexed path is broken;
- a context-package, close-input, final report, or operational handoff file is created as a persistent spec artifact.

### Failure action

In `PLANNING`, block with `needs_resume_replan`. In `RESUME`, repair or migrate the workspace while preserving IDs.

## `question_gate`

### Pass when

No open `Q-###` remains.

### Fail when

Any open question remains anywhere in the spec.

### Failure action

Block. The user must resolve, bypass, or scope out the question inside the spec. Execution agents cannot bypass questions.

## `slice_size_gate`

### Pass when

Each candidate `SL-###` is large enough to justify one full agent round and small enough to complete in one high-quality round.

### Fail when too small

- The slice is a microtask.
- It is only a file creation, rename, import, or isolated technical chore.

### Fail when too large

- The slice requires multiple independent behaviors.
- It spans too many unrelated areas.
- It cannot be safely implemented and reviewed in one round.

### Failure action

In `PLANNING`, block with `needs_resume_replan`.

In `RESUME`, re-slice using the next available `SL-###` IDs.

## `traceability_gate`

### Pass when

- each ready slice links to at least one `AC-###`;
- constraints and risks are linked where relevant;
- decisions are linked where they govern behavior;
- questions are linked where they block or inform work;
- traceability matrix uses IDs and paths only;
- traceability agrees with each slice file's linked IDs.

### Fail when

- a ready slice lacks ACs;
- a slice depends on title-only references;
- an acceptance criterion has no implementing slice and no explicit reason;
- a risk has no mitigation, constraint, linked slice, or explicit acceptance.
- traceability references an ID or path that does not exist.

## `validation_hint_gate`

### Pass when

Every executable slice has validation hints and those hints remain test-framework-agnostic.

### Fail when

- `validation_hints` are missing;
- hints become test scenarios or test implementation details.

## `readiness_gate`

A slice is ready only if all required gates pass:

- `workspace_gate`
- `canonical_id_gate`
- `question_gate`
- `slice_size_gate`
- `traceability_gate`
- `validation_hint_gate`

## `planning_gate`

`PLANNING` returns one of:

```yaml
planning_status: ready
```

```yaml
planning_status: blocked_by_open_questions
blockers: [Q-###]
```

```yaml
planning_status: blocked_needs_resume_replan
reason: slice_size_or_structure
next_mode: RESUME
```

```yaml
planning_status: incomplete_spec
missing: [objective, scope, acceptance_criteria, constraints, risks, validation_hints, lifecycle_files]
```

```yaml
planning_status: invalid_canonical_ids
invalid_items: [<description>]
```

```yaml
planning_status: broken_workspace_references
broken_paths: [<path>]
broken_ids: [AC-###, SL-###]
next_mode: RESUME
```

## `closure_gate`

`CLOSE` may proceed only when:

- the spec has no unresolved open questions;
- final business rules are clear;
- final acceptance criteria are stable;
- durable decisions are identified;
- relevant constraints and risks are known;
- durable content from shared and slice files has been consolidated;
- execution history can be removed without losing important business or technical context.

If closure would hide unresolved ambiguity, block instead of producing a misleading final spec.
