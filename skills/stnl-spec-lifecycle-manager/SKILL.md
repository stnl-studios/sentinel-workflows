---
name: stnl-spec-lifecycle-manager
description: Use to create, resume, validate, and close slice-driven feature specifications with stable canonical IDs, readiness gates, atomic slice execution, and token-efficient lazy loading.
---

# stnl-spec-lifecycle-manager

## Purpose

Manage a feature specification as a slice-driven lifecycle artifact. Use this skill to create a new spec, resume or replan an existing spec, validate whether it is ready for implementation, or close it into a clean final `feature_spec.md`.

This skill is not a generic markdown generator. It is a governance protocol for specs that must be safe for orchestrated implementation by specialized agents.

## When to use

Use this skill when the user asks to:

- create a new feature spec;
- resume, continue, or replan an existing feature spec;
- validate whether a feature spec is ready to start implementation;
- split a feature into executable slices;
- clean, finalize, or close a feature spec;
- enforce canonical IDs, acceptance criteria, constraints, risks, decisions, questions, or slice readiness.

## When not to use

Do not use this skill for:

- implementation work itself;
- test implementation itself;
- code review itself;
- writing product copy unrelated to a feature spec;
- generating a long project plan outside the feature-spec lifecycle;
- turning a spec into a task tracker with microtasks.

## Required MODE

Operate in exactly one MODE per invocation:

- `INIT`: start a new spec.
- `RESUME`: resume or replan an existing spec.
- `PLANNING`: validate readiness. Do not replan.
- `CLOSE`: produce a clean final `feature_spec.md`.

If MODE is missing, infer it only when obvious from the user request. If not obvious, ask the smallest necessary clarification.

## Core invariants

These rules always apply:

1. The spec is **slice-driven**. The canonical execution unit is `SL-001+`.
2. Do not use phases or phase IDs. `F-001` is not part of this skill.
3. Every canonical artifact must use a stable ID:
   - open questions: `Q-001+`
   - decisions: `D-001+`
   - acceptance criteria: `AC-001+`
   - slices: `SL-001+`
   - risks: `R-001+`
   - constraints: `C-001+`
4. Every artifact ID must appear in both the heading and an explicit `id:` field.
5. Never renumber, reuse, or silently normalize IDs.
6. Preserve existing valid IDs exactly.
7. Never reference canonical artifacts only by title when an ID exists.
8. Open questions block the spec. A user bypass must be recorded in the spec as a resolved question, decision, constraint, or explicit scope change.
9. `PLANNING` validates only. If the spec or a slice needs structural replanning, block and direct the user to `RESUME`.
10. Slice execution is atomic. If an external agent round fails, the spec is not updated.
11. During external execution, only the finalizer may update the spec, and only the completed slice.
12. `CLOSE` removes execution history and leaves only one clean `feature_spec.md`.

## Atomic slice execution contract

A slice is complete only when the full external round succeeds:

```text
orchestrator -> planner -> test planner -> coder -> validator -> reviewer -> finalizer
```

If any step fails, is incomplete, or produces unreviewed work, discard the round output and do not update the spec.

The finalizer does not close the whole spec. It updates only the completed slice and any durable artifacts created by that slice.

Read `references/agent-execution-contract.md` when preparing a spec for external agents or updating a slice after a successful execution round.

## Lazy-loading map

Load only the files needed for the active MODE.

| MODE | Required references |
|---|---|
| `INIT` | `references/modes.md`, `references/canonical-ids.md`, `references/spec-schema.md`, `references/slice-model.md`, `references/question-policy.md`, `references/qa-checklist.md`, `references/token-economy.md`, `templates/feature_spec.template.md` |
| `RESUME` | `references/modes.md`, `references/canonical-ids.md`, `references/slice-model.md`, `references/readiness-gates.md`, `references/question-policy.md`, `references/agent-execution-contract.md`, `references/token-economy.md` |
| `PLANNING` | `references/modes.md`, `references/canonical-ids.md`, `references/qa-checklist.md`, `references/readiness-gates.md`, `references/slice-model.md`, `references/token-economy.md` |
| `CLOSE` | `references/modes.md`, `references/canonical-ids.md`, `references/close-policy.md`, `references/spec-schema.md`, `references/token-economy.md` |

Load examples only when the format is unclear or the user explicitly asks for an example.

## MODE behavior summary

### `INIT`

Create a new slice-driven spec. Ask crucial questions if the request is superficial or ambiguous. Create initial canonical artifacts only when there is enough signal. Do not mark a slice `ready` if there are open questions.

### `RESUME`

Resume an existing spec, detect blockers, and replan slices if needed. `RESUME` may create new canonical IDs using the next available number. It must not renumber existing IDs.

### `PLANNING`

Validate whether the spec can start or resume implementation. Do not restructure the spec. If a slice is too large, too small, vague, missing required links, or blocked by questions, return a blocking result and instruct re-entry via `RESUME`.

### `CLOSE`

Create or update exactly one final `feature_spec.md`. Remove execution history, failed attempts, operational notes, resolved questions without durable value, and checklist noise. Keep business rules, final acceptance criteria, durable decisions, relevant constraints, relevant risks, and essential technical notes.

## Token discipline

Prefer IDs over repeated prose. Keep readiness and traceability compact. Do not duplicate acceptance criteria inside slices. Do not write test scenarios inside `qa_checklist` or `validation_hints`. During external slice execution, agents should receive only the current slice and the directly linked artifacts.

## Output discipline

For every MODE, produce the smallest complete output that moves the spec lifecycle forward.

When creating or updating files:

- write valid Markdown;
- keep headings stable;
- keep canonical IDs stable;
- avoid verbose commentary inside the spec;
- separate human-facing explanation from spec content when responding in chat.

## Evaluation guidance

When changing this skill, use `evals/eval-plan.md` to test the must-pass behaviors: ID stability, no open-question bypass, token-bloat control, planning gate behavior, close cleanup, and atomic slice update rules.
