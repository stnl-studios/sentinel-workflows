---
name: stnl-slice-executor
description: Execute one explicitly selected slice or apply its persisted findings, delegate checks automatically, and stop before formal validation or completion.
---

# stnl-slice-executor

## Purpose

Run exactly one manual operation: `EXECUTE_SLICE` or `APPLY_FINDINGS`. Work on one explicit normalized slice, delegate every applicable test or verification command to the configured validation runner, persist only compact evidence, and stop before formal validation or global completion. A manual operation may contain a bounded automatic correction-and-recheck cycle; it never creates another manual operation.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- `SLICE`: required and explicit. Accept one unsigned decimal number and normalize it to `slice-NN`; never infer it.
- Optional additional context may narrow the selected operation but cannot expand approved scope.
- The launcher supplies the platform-specific runner invocation. This skill contains no vendor-specific invocation syntax.

## Authority

Requirements and approved plans define scope. `tasks.md` defines global progress and is read-only for this skill. The selected detailed task file authorizes local work and records execution. The configured runner owns only the check result; it does not own implementation, correction, persistence, the formal validation verdict, or completion. Other slice artifacts are out of scope unless a concrete dependency must be checked read-only.

## Minimum Reads

- `plan.md`, `tasks.md`, selected detailed plan and task file;
- requirements referenced by the selected slice;
- directly related code, tests, imports, dependencies, and prior compact test evidence only.

## Delegated Checks

Check every operation precondition before implementation or correction. Missing or invalid input, an absent slice or artifact, an incomplete serial dependency, an unapproved plan, absent tasks, a concluded slice, an already-blocking divergence, or an out-of-phase operation may block before implementation or correction and therefore before any runner invocation. Once implementation or correction has occurred, the operation cannot end without invoking the configured runner.

After implementation or correction, determine the final changed and removed scope without running verification commands in the main context. Tests, builds used as verification, linters, typechecks, compilations, validators, contract checks, migration checks, and regression suites are runner-only work.

Invoke the configured runner at least once and at most three times within the same manual operation. The first invocation is mandatory after the initial implementation or correction and cannot be skipped because the change appears simple or because no check is expected to apply; the runner performs independent discovery and returns `TESTS_NOT_APPLICABLE` when appropriate. The local invocation budget starts at three for each `EXECUTE_SLICE` or `APPLY_FINDINGS` invocation and is never shared with a later operation. Every runner request carries the same operation, normalized identifiers, derived execution paths, relevant compact evidence, current changed scope, applicable additional context, and the automatic round as `1/3`, `2/3`, or `3/3`. Do not send full logs already loaded in the main context. The runner remains read-only over code and execution artifacts and returns only the schema for that operation with exactly `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE`, or `BLOCKED`.

Persist every valid result append-only before deciding what follows. Implementation checks use the next global `implementation-check-NN`; findings checks use the next global `findings-check-NN`. A later manual invocation has its own three-call budget but continues each section's sequence instead of resetting it. Every record includes the automatic round and limit, tested state, verification commands with numeric exit codes, failures, corrections covered, scope, check discovery sources and relevant read-only discovery actions, non-applicability rationale, unexpected workspace effects, and compact persistence summary. `TESTS_NOT_APPLICABLE` is valid only after objective discovery and when no verification command was executed; read-only actions used only to discover applicable checks are permitted and recorded under `Check discovery sources`.

The operation may end after implementation or correction only after a valid auxiliary status is received or the runner fails to start or returns malformed output with an objective cause. Stop the cycle on `TESTS_PASS`, `TESTS_NOT_APPLICABLE`, `BLOCKED`, the third `TESTS_FAIL`, or a correction that needs an unauthorized requirement, plan, dependency, strategy, scope, or other slice decision. If the runner cannot start or returns malformed output, persist `BLOCKED` with the concrete cause and stop. Additional invocations occur only after `TESTS_FAIL` in round one or two and an authorized correction. Never make a fourth automatic invocation, use an unbounded loop, fall back to checks in the main context, invent a result, implement or correct through the runner, create a Validation Attempt or Effective Validation Base, set a final result, mark `[x]`, or continue automatically to another operation, including `VALIDATE_SLICE`.

After `TESTS_FAIL` in round one or two, the main context may correct only when the failure evidence objectively identifies a correction inside the approved slice, without changing requirements or strategy, replanning, modifying another slice, or treating an unrelated preexisting failure. Before the next runner invocation, append a compact correction record containing the reported failure, evidence, applied change, affected files, updated scope, and why the correction remains inside the slice. Preserve every earlier check and correction record.

## EXECUTE_SLICE

Require an open, dependency-ready slice with approved plans and materialized tasks. Implement only its checklist. Update local checklist items, actual changed areas, discovered expansion, divergences, and a compact diff summary. Then delegate checks automatically and append the result under `Implementation Test Evidence` as the next `implementation-check-NN`, including status, tested state, commands and numeric exit codes, selected tests, selection rationale, coverage, compact evidence or failure summary, blockers, unexpected workspace effects, and persistence summary.

Compare every changed path with the Effective Validation Bases of earlier completed slices. Record each overlap under `Prior Validation Overlap` with the earlier slice, affected behavior, and regressions the current validation must justify. Include the path in the current slice's changed areas. Do not reopen or rewrite an earlier slice.

On `TESTS_FAIL` before the third round, apply only an objectively supported in-scope correction, update the changed scope, record the correction, and invoke the runner again within the same `EXECUTE_SLICE`. If that correction is not authorized, record the applicable blocking divergence and stop. On the third `TESTS_FAIL`, persist the evidence and stop without another automatic correction. On `TESTS_NOT_APPLICABLE`, persist the discovery sources, relevant read-only discovery actions, verification types considered, objective rationale, and confirmation that no verification command was executed. On `BLOCKED`, record the cause and required action. Every status leaves the slice open and formal validation pending; no check creates a formal finding or invokes `APPLY_FINDINGS` or `VALIDATE_SLICE`.

## APPLY_FINDINGS

Require persisted findings. Read those findings, the selected plan and task record, affected code and tests, and necessary requirements. Correct only reported problems and their necessary effects. Record each correction, every final affected or removed path, and newly discovered prior-slice overlap. Preserve all Validation Attempts and any historical Effective Validation Base until a later formal `PASS` replaces it.

Then delegate checks automatically and append the result under `Findings Test Evidence` as the next `findings-check-NN`, associated with the applicable findings cycle. In addition to the common check evidence, record findings verified, corrections covered, regressions selected, and findings not yet supported by tests.

On `TESTS_FAIL` before the third round, adjust only persisted findings, failures introduced or exposed by their corrections, directly related regressions, and necessary effects inside approved scope. Update corrections and changed scope, record the between-round correction, and invoke the runner again within the same `APPLY_FINDINGS`. On the third `TESTS_FAIL`, persist the evidence, preserve findings, leave unsupported findings unresolved, and stop without another automatic correction. On `TESTS_NOT_APPLICABLE`, persist objective discovery, relevant read-only discovery actions, verification types considered, rationale, and confirmation that no verification command was executed without treating findings as resolved merely from that status. On `BLOCKED`, preserve the cause and required action. Do not perform formal validation, mark completion, set the final result, replace prior Validation Attempts or the Effective Validation Base, or invoke `VALIDATE_SLICE` automatically. If correction requires a requirement, scope, dependency, or strategy change, record a blocking divergence and direct it to the appropriate planning or requirements operation.

## Allowed Effects

- modify implementation and tests inside the selected scope;
- after implementation or correction, invoke the configured runner at least once and no more than three times in the selected manual operation;
- update only execution-owned sections of `tasks/slice-NN.md`, including the appropriate append-only test-evidence section.

## Blocks

Block missing or invalid inputs, absent artifacts, incomplete dependencies, a concluded slice, unknown blocking divergence, out-of-scope work, a required planning/requirements decision, unavailable or malformed runner behavior after persisting its objective cause, or an attempt to mutate plans, the global task index, another slice, or a concluded slice.

## Output

Report operation, selected slice, changed areas, delegated-check status and evidence location, divergences, and the next appropriate explicit action. Stop.
