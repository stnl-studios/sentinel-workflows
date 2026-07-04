# File Purpose Header

```yaml
purpose: Define the living and final feature_spec.md structures.
load_when: Creating a new spec, validating full structure, or closing a spec.
do_not_load_when: Only a single slice or ID rule is needed.
contains: Required sections, optional sections, living-spec schema, close-spec schema, and field rules.
owner: stnl-spec-lifecycle-manager
update_policy: Change when the SPEC artifact contract changes.
```

# SPEC Schema

The working artifact is `feature_spec.md`.

During lifecycle work, it is a living spec. During `CLOSE`, it becomes a clean final spec.

## Living spec sections

A living `feature_spec.md` should use this order:

1. File Purpose Header
2. Spec Metadata
3. Objective
4. Scope
5. Out of Scope
6. Open Questions
7. Decisions
8. Acceptance Criteria
9. Constraints
10. Risks
11. Slices
12. QA Checklist
13. Traceability Matrix
14. Resume Notes

Omit optional empty sections only when doing so does not hide important absence. For example, if there are no risks, prefer an explicit short note: `No material risks identified yet.`

## Final spec sections after `CLOSE`

A closed `feature_spec.md` should use this order:

1. File Purpose Header
2. Objective
3. Final Scope
4. Out of Scope
5. Business Rules
6. Final Acceptance Criteria
7. Durable Decisions
8. Relevant Constraints
9. Relevant Risks
10. Essential Technical Notes

Do not preserve detailed slice execution history in the final spec.

## File Purpose Header

Every `feature_spec.md` must start with a short purpose header:

```yaml
purpose: Explain what this spec governs.
status: draft | ready | blocked | closed
mode_last_updated: INIT | RESUME | PLANNING | CLOSE
canonical_artifacts: [Q, D, AC, SL, R, C]
read_when: State when agents should read this file.
do_not_read_when: State when a narrower slice context is enough.
```

Keep this header short. It is an index, not a summary.

## Spec Metadata

Recommended fields:

```yaml
spec_id: <short stable slug if available>
spec_status: draft | ready | blocked | closed
created_from_mode: INIT
last_updated_mode: INIT | RESUME | PLANNING | CLOSE
current_slice: SL-### | null
next_candidate_slice: SL-### | null
open_question_count: <number>
```

## Objective

The objective must state what the feature changes and why it matters.

A good objective is:

- short;
- specific;
- tied to user, business, system, or operational value;
- not an implementation plan.

## Scope and Out of Scope

Scope must define what is included. Out of Scope must define what must not be implemented.

Out of Scope is a first-class anti-drift control.

## Open Questions

Open questions use `Q-001+`. No spec may be `ready` while any open question remains unresolved.

Resolved questions may remain during the living lifecycle if they provide useful traceability. Remove them in `CLOSE` unless they preserve durable context.

## Decisions

Decisions use `D-001+` and should capture only durable decisions.

Record decisions that affect:

- business rules;
- API contracts;
- data model;
- architecture;
- security or permissions;
- integration behavior;
- compatibility;
- meaningful error behavior.

Do not record local implementation trivia.

## Acceptance Criteria

Acceptance criteria use `AC-001+`.

A good acceptance criterion is:

- observable;
- stable enough for implementation and validation;
- tied to expected behavior;
- not a test scenario;
- not a task.

## Constraints

Constraints use `C-001+`.

They define anti-drift boundaries. They should prevent scope expansion, unauthorized architecture changes, unexpected contract changes, unsafe assumptions, or overengineering.

## Risks

Risks use `R-001+`.

Risks should include impact, likelihood when useful, mitigation, and linked constraints or slices.

## Slices

Slices use `SL-001+` and are the unit of external agent execution.

A slice must not be a microtask. It must also not be so large that a full external round cannot complete it with high quality.

## QA Checklist

The `qa_checklist` is a Spec Quality Gate, not a test plan. It should be compact and derived from canonical IDs.

## Traceability Matrix

The matrix must be compact and ID-only whenever possible:

| Slice | ACs | Constraints | Risks | Decisions | Questions |
|---|---|---|---|---|---|
| `SL-001` | `AC-001` | `C-001` | `R-001` | `D-001` | — |

Do not repeat artifact descriptions inside the matrix.

## Resume Notes

Keep resume notes short and operational:

```yaml
last_completed_slice: SL-### | null
next_candidate_slice: SL-### | null
blocked_by: [Q-###, R-###]
context_to_load_next: [SL-###, AC-###, C-###]
```

Do not store chat history or failed execution logs here.
