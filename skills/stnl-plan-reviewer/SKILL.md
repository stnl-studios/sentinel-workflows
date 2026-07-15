---
name: stnl-plan-reviewer
description: Independently review and directly correct global and detailed execution plans before task materialization.
---

# stnl-plan-reviewer

## Purpose

Run only `REVIEW_PLAN`. Perform an independent critical review of `plan.md` and every `plans/slice-NN.md`, correct them directly, approve a coherent result, and stop.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may identify a concrete concern but cannot change requirements.

## Authority

Requirements remain authoritative. This skill may change only `plan.md` and `plans/slice-NN.md`. It cannot create tasks, edit code, or resolve documentary ambiguity.

## REVIEW_PLAN

Derive the root state before reading for correction. Run only in `planned`: `plan.md` and the complete detailed plan set exist, while `tasks.md`, task files, and operational evidence do not. It may be repeated in that state. If any task artifact exists, return `NEEDS_REPLAN`, preserve all plans byte-for-byte, and explain that the user must explicitly reinitialize the execution root before new planning. Never reset automatically.

Check full requirement coverage, missing owners, overlap, slice sizing, strict serial order, dependencies, public contracts, persistence, migrations, authentication and authorization, external integrations, shared state, breaking changes, architectural risk, expected tests, implicit work, accidental scope, and consistency between global and detailed plans.

Open code only to verify a concrete concern. Split, combine, reorder, or revise slices as needed. Add a final integration or stabilization slice when technically required. If a correction needs a requirements decision, return the appropriate handoff to the requirements lifecycle instead of masking it.

When the review succeeds, set the File Purpose Header status of `plan.md` and every detailed plan to `ready`, set each review state to `approved`, and ensure global and detailed artifacts agree.

## Minimum Reads

- normalized requirements source and referenced requirement records;
- `plan.md` and every detailed plan;
- code only for a named risk or hidden dependency.

## Allowed Effects

- modify, create, remove, or reorder planning artifacts needed to leave one coherent approved plan set;
- report exact corrections made.

## Blocks

Block with a requirements handoff when approval depends on missing, conflicting, or changed requirements. Return `NEEDS_REPLAN` without writes when the root is no longer `planned`. Do not invent answers, create tasks, or alter planning artifacts after materialization.

## Output

Report approval status and concise corrections. Stop after `REVIEW_PLAN`.
