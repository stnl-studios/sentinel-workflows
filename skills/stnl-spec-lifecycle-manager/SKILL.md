---
name: stnl-spec-lifecycle-manager
description: Use to create, resume, validate readiness, and close modular slice-driven feature specification workspaces with stable canonical IDs, readiness gates, spec-state controls, and selective loading.
---

# stnl-spec-lifecycle-manager

## Purpose

Manage a feature specification as a modular, slice-driven workspace. Use this skill to create a new operational spec workspace, resume or replan an existing workspace, validate whether it is ready for the external slice workflow, or close it into a clean final `feature_spec.md`.

This skill is not a generic markdown generator. It is a governance protocol for specs that must be safe for an orchestrated delivery workflow.

## When to use

Use this skill when the user asks to:

- create a new feature spec;
- resume, continue, or replan an existing feature spec;
- validate whether a feature spec is ready to enter the external slice workflow;
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

1. The live spec is a **modular workspace**, not a monolithic document.
2. The operational `feature_spec.md` is a compact index and manifest only.
3. The canonical execution unit is `SL-001+`, stored in its own `slices/SL-###.md` file.
4. Do not use phases or phase IDs. `F-001` is not part of this skill.
5. Every canonical artifact must use a stable ID:
   - open questions: `Q-001+`
   - decisions: `D-001+`
   - acceptance criteria: `AC-001+`
   - slices: `SL-001+`
   - risks: `R-001+`
   - constraints: `C-001+`
6. Every artifact ID must appear in both the heading and an explicit `id:` field.
7. Never renumber, reuse, fill gaps, or silently normalize IDs.
8. Preserve existing valid IDs exactly.
9. Never reference canonical artifacts only by title when an ID exists.
10. Open questions block the spec. A user bypass must be recorded as a resolved question, decision, constraint, or explicit scope change.
11. `PLANNING` is read-only. If the workspace or a slice needs structural replanning, block and direct the user to `RESUME`.
12. Slice execution has spec-state atomicity: if an external agent round fails, the spec workspace does not advance.
13. During external execution, no agent may update the spec workspace. The developer may complete the slice manually only after Validator and Reviewer both pass. This skill may update the workspace only when explicitly invoked in a lifecycle MODE.
14. No permanent slice context package is created. The orchestrator builds the slice handoff in memory from selective reads.
15. `CLOSE` is the only mode that compacts the workspace and leaves exactly one clean `feature_spec.md`.

## Slice Execution State Contract

A slice is eligible for manual completion only when the full external round succeeds:

```text
orchestrator -> planner -> developer approval -> test-planner -> developer approval -> coder -> validator -> reviewer -> developer completion
```

If any step fails, is incomplete, or produces unreviewed work, the spec workspace stays at the previous canonical state. Code changes may remain in the working tree for correction, but the slice is not marked done.

After Validator and Reviewer pass, the developer reviews the final handoff and manually applies the Developer Completion Protocol. The reviewer is the last agent; no agent updates the spec after it.

Read `references/agent-execution-contract.md` when preparing a spec for external agents or completing a slice after a successful execution round.

## Lazy-loading map

Load only the files needed for the active MODE.

| MODE | Required references |
|---|---|
| `INIT` | `references/modes.md`, `references/spec-workspace.md`, `references/canonical-ids.md`, `references/spec-schema.md`, `references/slice-model.md`, `references/question-policy.md`, `references/qa-checklist.md`, `references/token-economy.md`, modular templates needed for materialized files |
| `RESUME` | `references/modes.md`, `references/spec-workspace.md`, `references/canonical-ids.md`, `references/slice-model.md`, `references/readiness-gates.md`, `references/question-policy.md`, `references/agent-execution-contract.md`, `references/token-economy.md`, slice/shared templates only if creating files |
| `PLANNING` | `references/modes.md`, `references/spec-workspace.md`, `references/canonical-ids.md`, `references/qa-checklist.md`, `references/readiness-gates.md`, `references/slice-model.md`, `references/token-economy.md` |
| `CLOSE` | `references/modes.md`, `references/spec-workspace.md`, `references/canonical-ids.md`, `references/close-policy.md`, `references/spec-schema.md`, `references/token-economy.md`, `templates/closed-feature_spec.template.md` |

Load examples only when the format is unclear or the user explicitly asks for an example.

## MODE behavior summary

### `INIT`

Create a new modular workspace, defaulting to `specs/<feature-slug>/` when no stronger consumer convention exists. Create `feature_spec.md` as a compact index, materialized shared files only when needed, one file per slice, and required lifecycle files. Do not mark a slice `ready` if there are open questions.

### `RESUME`

Resume an existing workspace, starting from `feature_spec.md` and `lifecycle/resume-notes.md`. Load only the candidate slice and linked artifacts unless more is justified. `RESUME` may migrate an old monolithic operational `feature_spec.md` into the modular workspace while preserving IDs and durable content.

### `PLANNING`

Validate whether the workspace can start or resume external agent execution. Do not write files. Validate paths, IDs, links, slice file consistency, traceability, QA state, and open questions. If structural change is needed, return `needs_resume_replan`.

### `CLOSE`

Compact the operational workspace into exactly one final `feature_spec.md`. Remove `shared/`, `slices/`, and `lifecycle/` after durable content is consolidated. Do not create archives, changelogs, histories, or context-package files by default.

## Token discipline

Prefer IDs over repeated prose. Keep the operational index, readiness, traceability, and resume notes compact. Do not duplicate acceptance criteria inside slices. Do not write test scenarios inside `qa-checklist.md` or `validation_hints`. During external slice execution, agents receive only the current slice and directly linked artifacts.

## Output discipline

For every MODE, produce the smallest complete output that moves the spec lifecycle forward.

When creating or updating files:

- write valid Markdown;
- keep headings stable;
- keep canonical IDs stable;
- avoid verbose commentary inside the spec;
- separate human-facing explanation from spec content when responding in chat.

## Evaluation guidance

When changing this skill, use `evals/eval-plan.md` to test the must-pass behaviors: ID stability, no open-question bypass, token-bloat control, planning gate behavior, close cleanup, and spec-state atomicity rules.
