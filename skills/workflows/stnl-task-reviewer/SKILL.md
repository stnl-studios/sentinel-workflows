---
name: stnl-task-reviewer
description: Review freshly materialized tasks against approved plans and correct only task artifacts.
---

# stnl-task-reviewer

## Purpose

Run only explicit `REVIEW_TASKS`. This is the normal post-materialization review, compares approved plans with materialized tasks, corrects task artifacts, and stops. It creates no persistent review mode or second approval authority; direct `EXECUTE_SLICE` remains legally available from pristine state but is not the normal materializer handoff.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may point to a checklist concern but cannot change plans.

## Authority

`plan.md` and `plans/slice-NN.md` are read-only strategy authority. This skill may alter only `tasks.md` and `tasks/slice-NN.md`. Requirements and code are read-only and normally unnecessary.

Execution preflight is read-only. Only when it reports a mechanical violation for the exact `Findings IDs` alias or the exact historical `Check discovery sources` / `Check discovery actions` pair may this skill explicitly run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --repair-known-contract` once and repeat the original preflight; every other contract violation blocks.

## REVIEW_TASKS

Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> REVIEW_TASKS`. Run only in `MATERIALIZED_PRISTINE`: the full task set exists; all fingerprint/revision references match; all global and local checkboxes are `[ ]`; global validation/result values are `pending`; and every operational section, including `Delegation Blocker`, uses its exact pristine sentinel.

Any marked local task, actual change, operational record, non-pending result, or `[x]` global row means execution has started. Outside `MATERIALIZED_PRISTINE`, preflight returns `BLOCKED` with exact state-derived recovery targets; preserve all plans/tasks byte-for-byte. In `REQUIREMENTS_CHANGED`, `REPLAN` is the `NEEDS_REPLAN` route. Do not remove or reorder executed work or turn task review into replanning.

Check that no plan obligation was lost and no task was invented. Verify fidelity, coverage, granularity, order, dependencies, objective results, tests, slice isolation, absence of work belonging elsewhere, consistency between global and detailed tasks, and economy of context for execution. Correct task artifacts directly when the approved plan already determines the answer.

Compose any model-authored task corrections in an isolated complete execution candidate and execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>` before publication. This is contract/model enforcement; runtime parsing is not publication authority. Candidate rejection preserves live bytes. After PASS publish only task-review-owned paths and use the final handoff command as strict readback.

In checklist `expected areas`, treat only Markdown code spans as concrete filesystem claims and verify each relative to the detailed task. Keep conceptual labels outside code spans. Correct the claim itself when candidate validation reports a path-basis error—never reinterpret it as project-root-relative or publish an automatic rewrite.

## Minimum Reads

- `plan.md` and every detailed plan;
- `tasks.md` and every detailed task file;
- referenced requirements only when needed to verify an objective criterion.

## Allowed Effects

- modify only task artifacts while preserving exactly one global row per slice and binary progress.

## Blocks

Return `NEEDS_REPLAN` without changing plans when a pristine review requires strategy, scope, requirements, dependencies, slice boundaries, or current requirements authority to change; the executable next action is explicit `REPLAN` with the returned diagnostic as `REPLAN_REASON`. Return `BLOCKED` without writes from any other state, partial set, or malformed layout.

## Output

After successful review, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after REVIEW_TASKS`. Report corrected task paths or `NEEDS_REPLAN`, the runtime's normal handoff, and all legal operations. The normal handoff is `stnl-slice-executor / OPERATION=EXECUTE_SLICE / SLICE=<persisted-frontier>`; `REPLAN` remains a legal alternative. Stop after `REVIEW_TASKS`.
