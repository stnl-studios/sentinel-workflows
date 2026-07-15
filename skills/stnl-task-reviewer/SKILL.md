---
name: stnl-task-reviewer
description: Optionally review materialized tasks against approved plans and correct only task artifacts.
---

# stnl-task-reviewer

## Purpose

Run only explicit `REVIEW_TASKS`. This optional operation compares approved plans with materialized tasks, corrects task artifacts, and stops. Its invocation is the user's choice; it creates no persistent review mode or second approval authority.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may point to a checklist concern but cannot change plans.

## Authority

`plan.md` and `plans/slice-NN.md` are read-only strategy authority. This skill may alter only `tasks.md` and `tasks/slice-NN.md`. Requirements and code are read-only and normally unnecessary.

## REVIEW_TASKS

Derive the root state from the task schemas before any write. Run only in `materialized-pristine`: the full task set exists; all global and local checkboxes are `[ ]`; global validation/result values are `pending`; changed areas and diff summary are `pending`; scope expansion, prior overlap, divergences, developer checks, Validation Attempts, findings, corrections, and Effective Validation Base use their pristine sentinels; and every final result is `pending`.

Any marked local task, actual change, recorded file, scope expansion, prior overlap, divergence, developer check, Validation Attempt, finding, correction, Effective Validation Base, non-pending result, or `[x]` global row means execution has started. In `execution-started` or `complete`, return `BLOCKED` and preserve all plans and tasks byte-for-byte. Do not remove or reorder executed work and do not turn task review into replanning.

Check that no plan obligation was lost and no task was invented. Verify fidelity, coverage, granularity, order, dependencies, objective results, tests, slice isolation, absence of work belonging elsewhere, consistency between global and detailed tasks, and economy of context for execution. Correct task artifacts directly when the approved plan already determines the answer.

## Minimum Reads

- `plan.md` and every detailed plan;
- `tasks.md` and every detailed task file;
- referenced requirements only when needed to verify an objective criterion.

## Allowed Effects

- modify only task artifacts while preserving exactly one global row per slice and binary progress.

## Blocks

Return `NEEDS_REPLAN` without changing plans when a pristine review requires strategy, scope, requirements, dependencies, or slice boundaries to change. Return `BLOCKED` without any write when state is `execution-started`, `complete`, partial, or malformed.

## Output

Report corrected task paths or `NEEDS_REPLAN`. Stop after `REVIEW_TASKS`.
