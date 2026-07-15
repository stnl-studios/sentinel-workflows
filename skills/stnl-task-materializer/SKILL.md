---
name: stnl-task-materializer
description: Materialize compact global progress and detailed operational checklists exclusively from approved execution plans.
---

# stnl-task-materializer

## Purpose

Run only `MATERIALIZE_TASKS`. Convert the approved plan set into `tasks.md` and every `tasks/slice-NN.md` without reinterpreting strategy or exploring implementation by default.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may narrow formatting but cannot change the approved plan.

## Authority

Approved `plan.md` and detailed plans are the only materialization authority. Requirements clarify referenced acceptance only. This skill may create task artifacts exactly once and may not alter plans, requirements, or code.

## MATERIALIZE_TASKS

Before writing, require root state `planned`, `plan.md`, every referenced detailed plan, File Purpose Header status `ready`, review state `approved`, matching slice sets, consistent order, dependencies, scope, and references. Also require that `tasks.md` does not exist and that no `tasks/slice-NN.md` exists. Any task artifact, including a partial set, blocks without replacement, completion, reconstruction, or deletion.

Validate every precondition and render the full task set before publishing any artifact. Stage only files from this invocation, publish the complete set only after all renders succeed, and on a write failure remove only staged or newly published files from this invocation so no partial task set remains. Never touch preexisting paths.

Create exactly one `[ ]` row per approved slice in `tasks.md`, using only `[ ]` and `[x]`. Create every detailed task file. Each task must have an observable result, expected area, requirement reference, and coherent operational order. Include expected tests and the evidence, findings, corrections, validation-base, diff-summary, and final-result sections needed by later operations. Keep the global index compact and details local.

## Minimum Reads

- `plan.md` and every approved detailed plan;
- only requirement excerpts needed to make acceptance objective;
- task templates when writing.

## Allowed Effects

- create `tasks.md` and all `tasks/slice-NN.md` corresponding exactly to approved slices.

## Blocks

Return `NEEDS_REPLAN` without writing when plans are missing, unapproved, inconsistent, or cannot be converted without a new decision. Return `BLOCKED` without writing when any task artifact already exists. Never repair or alter a plan.

## Output

Report created task paths, slice count, and any `NEEDS_REPLAN` reason. Stop after `MATERIALIZE_TASKS`.
