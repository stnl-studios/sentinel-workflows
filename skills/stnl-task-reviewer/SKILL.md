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

Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> REVIEW_TASKS`. Run only in `MATERIALIZED_PRISTINE`: the full task set exists; all fingerprint/revision references match; all global and local checkboxes are `[ ]`; global validation/result values are `pending`; and every operational section, including `Delegation Blocker`, uses its exact pristine sentinel.

Any marked local task, actual change, operational record, non-pending result, or `[x]` global row means execution has started. Outside `MATERIALIZED_PRISTINE`, preflight returns `BLOCKED` with the exact state and its canonical legal next operation; preserve all plans/tasks byte-for-byte. In `REQUIREMENTS_CHANGED`, that next operation is `REPLAN`, which is the canonical `NEEDS_REPLAN` route. Do not remove or reorder executed work or turn task review into replanning.

Check that no plan obligation was lost and no task was invented. Verify fidelity, coverage, granularity, order, dependencies, objective results, tests, slice isolation, absence of work belonging elsewhere, consistency between global and detailed tasks, and economy of context for execution. Correct task artifacts directly when the approved plan already determines the answer.

## Minimum Reads

- `plan.md` and every detailed plan;
- `tasks.md` and every detailed task file;
- referenced requirements only when needed to verify an objective criterion.

## Allowed Effects

- modify only task artifacts while preserving exactly one global row per slice and binary progress.

## Blocks

Return `NEEDS_REPLAN` without changing plans when a pristine review requires strategy, scope, requirements, dependencies, slice boundaries, or current requirements authority to change; the executable next action is explicit `REPLAN` with the returned diagnostic as `REPLAN_REASON`. Return `BLOCKED` without writes from any other state, partial set, or malformed layout.

## Output

Report corrected task paths or `NEEDS_REPLAN`. Stop after `REVIEW_TASKS`.
