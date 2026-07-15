---
name: stnl-slice-executor
description: Execute one explicitly selected slice or apply its persisted findings without performing independent validation or completion.
---

# stnl-slice-executor

## Purpose

Run exactly one operation: `EXECUTE_SLICE` or `APPLY_FINDINGS`. Work on one explicit normalized slice, update its local operational record, and stop before independent validation or global completion.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- `SLICE`: required and explicit. Accept one unsigned decimal number and normalize it to `slice-NN`; never infer it.
- Optional additional context may narrow the selected operation but cannot expand approved scope.

## Authority

Requirements and approved plans define scope. `tasks.md` defines global progress and is read-only for this skill. The selected detailed task file authorizes local work and records execution. Other slice artifacts are out of scope unless a concrete dependency must be checked read-only.

## Minimum Reads

- `plan.md`, `tasks.md`, selected detailed plan and task file;
- requirements referenced by the selected slice;
- directly related code, tests, imports, and dependencies only.

## EXECUTE_SLICE

Require an open, dependency-ready slice with approved plans and materialized tasks. Implement only its checklist. Update local checklist items, actual changed areas, discovered expansion, divergences, useful developer checks, and a compact diff summary. Developer checks are not authoritative validation evidence.

Compare every changed path with the Effective Validation Bases of earlier completed slices. Record each overlap under `Prior Validation Overlap` with the earlier slice, affected behavior, and regressions the current validation must justify. Include the path in the current slice's changed areas. Do not reopen or rewrite an earlier slice.

Do not mark the global row complete, set a final result, invoke an independent runner, or continue to another operation.

## APPLY_FINDINGS

Require persisted findings. Read those findings, the selected plan and task record, affected code and tests, and necessary requirements. Correct only reported problems and their necessary effects. Record each correction, every final affected or removed path, newly discovered prior-slice overlap, and useful focused developer checks. Preserve all Validation Attempts and any historical Effective Validation Base until a later `PASS` replaces it.

Do not perform independent validation, mark completion, or set the final result. If correction requires a requirement, scope, dependency, or strategy change, record a blocking divergence and direct it to the appropriate planning or requirements operation.

## Allowed Effects

- modify implementation and tests inside the selected scope;
- update only execution-owned sections of `tasks/slice-NN.md`.

## Blocks

Block missing or invalid inputs, absent artifacts, incomplete dependencies, a concluded slice, unknown blocking divergence, out-of-scope work, a required planning/requirements decision, or an attempt to mutate plans, the global task index, another slice, or a concluded slice.

## Output

Report operation, selected slice, changed areas, developer checks, divergences, and the next explicit validation action. Stop.
