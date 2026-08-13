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

Current requirements authority and approved plans define scope. `tasks.md` defines global progress and is read-only for this skill. The selected detailed task file authorizes local work and records execution. Its `Requirements authority` and `Plan revision` must match the current open slice and deterministic preflight. The configured independent runner owns only the check result; it does not own implementation, correction, persistence, the formal validation verdict, or completion. Other slice artifacts are out of scope unless a concrete dependency must be checked read-only.

## Minimum Reads

- `plan.md`, `tasks.md`, selected detailed plan and task file;
- requirements referenced by the selected slice;
- local `references/execution-record-schema.md` before persisting or interpreting findings, divergences, checks, or supersession;
- directly related code, tests, imports, dependencies, and prior compact test evidence only.

## Delegated Checks

Before content reads, implementation, correction, or delegation, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> <OPERATION> <SLICE>`. Its structural, state, serial-order, requirements-authority, task-schema, active-record, recovery-target, and third-failure gates are deterministic authority. When it blocks, preserve its exact state-derived diagnostic, including the concrete legal operation and slice when present; never substitute values inferred from the current request. Missing or invalid input, an absent slice or artifact, an incomplete serial dependency, an unapproved or stale plan, absent tasks, a concluded slice, an active blocking divergence, an out-of-phase operation, or prior `3/3 TESTS_FAIL` blocks before implementation or correction and therefore before any runner invocation. Once implementation or correction has occurred, the operation cannot end without invoking the configured independent runner.

After implementation or correction, determine the final changed and removed scope without running verification commands in the main context. Tests, builds used as verification, linters, typechecks, compilations, validators, contract checks, migration checks, and regression suites are runner-only work.

Start each logical runner invocation in a new independent delegated session with no inherited conversation history, using the platform launcher supplied by the caller. Send only the explicit minimum payload: operation, `SPEC_PATH`, derived execution root, selected slice, plan/task paths, current requirements fingerprint and plan revision, applicable active findings or corrections, current changed scope, compact relevant evidence, automatic round when applicable, and strictly necessary additional context. Never send conversation history or full logs. The runner remains read-only over code and execution artifacts.

Invoke the configured independent runner at least once and at most three times within the same manual operation. The first invocation is mandatory after the initial implementation or correction and cannot be skipped because the change appears simple or because no check is expected to apply; the runner performs independent discovery and returns `TESTS_NOT_APPLICABLE` when appropriate. The local invocation budget starts at three for each `EXECUTE_SLICE` or `APPLY_FINDINGS` invocation and is never shared with a later operation. Each successfully started runner request carries the applicable minimum payload and the automatic round as `1/3`, `2/3`, or `3/3`. It returns only the schema for that operation with exactly `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE`, or `BLOCKED`.

Persist every valid result append-only before deciding what follows. Implementation checks use the next global `implementation-check-NN`; findings checks use the next global `findings-check-NN`. A later manual invocation has its own three-call budget but continues each section's sequence instead of resetting it. Every record includes the automatic round and limit, tested state, verification commands with numeric exit codes, failures, corrections covered, scope, check discovery sources and relevant read-only discovery actions, non-applicability rationale, unexpected workspace effects, and compact persistence summary. `TESTS_NOT_APPLICABLE` is valid only after objective discovery and when no verification command was executed; read-only actions used only to discover applicable checks are permitted and recorded under `Check discovery sources`.

Classify delegation outcomes before persistence: initialization/transport failure, valid runner `BLOCKED`, malformed runner output, `TESTS_FAIL`, and verification-command failure are distinct. A verification-command failure is represented only by a valid `TESTS_FAIL`; a valid `BLOCKED` is a runner result, not a transport failure.

For an initialization or transport failure only, retry the same logical invocation at most once using a new independent session and the same minimum payload. Neither technical start attempt consumes automatic round `1/3`, `2/3`, or `3/3`, creates a `Validation Attempt`, allocates `implementation-check-NN` or `findings-check-NN`, or authorizes a code correction. If the second start also fails, persist exactly one active `Delegation Blocker` singleton with `Kind: initialization` under the selected task's canonical section, both compact transport causes, and the required action, then stop in `RUNNER_INITIALIZATION_BLOCKED`. A malformed response after the runner started is not retried as transport and persists the same singleton with `Kind: malformed-output`, without allocating a check identifier, then stops in `RUNNER_RESULT_BLOCKED`.

When the same stored operation and slice are invoked again from either runner-blocked state, resume directly at the logical runner invocation. Do not reimplement, reapply findings, duplicate checklist or diff summaries, duplicate the blocker, reset global identifiers, or allocate an automatic round or check identifier before a runner session actually starts. If transport fails definitively again, update the existing singleton instead of appending another record. A later valid record resolves it atomically under `references/execution-record-schema.md`.

The operation may end after implementation or correction only after a valid auxiliary status is received or a definitive delegation blocker is persisted. `TESTS_PASS`/`TESTS_NOT_APPLICABLE` enter `IMPLEMENTED_AWAITING_VALIDATION` or `FINDINGS_CORRECTED`; valid runner `BLOCKED` enters `AUXILIARY_BLOCKED` and only the same operation/slice may resume after its prerequisite. Additional automatic rounds occur only after `TESTS_FAIL` in round one or two and an authorized correction. Round `3/3 TESTS_FAIL` enters `IMPLEMENTATION_RETRY_EXHAUSTED` or `FINDINGS_RETRY_EXHAUSTED`: the next manual action is explicit `VALIDATE_SLICE`, and neither executor operation may re-enter until that formal verdict establishes the next state. Never make a fourth automatic invocation, use an unbounded loop, fall back to checks in the main context, invent a result, implement or correct through the runner, create a Validation Attempt or Effective Validation Base, set a final result, mark `[x]`, or continue automatically to another operation, including `VALIDATE_SLICE`.

After `TESTS_FAIL` in round one or two, the main context may correct only when the failure evidence objectively identifies a correction inside the approved slice, without changing requirements or strategy, replanning, modifying another slice, or treating an unrelated preexisting failure. Before the next runner invocation, update the canonical `Corrections Applied` path claims; persist the reported failure, evidence, applied change, affected files, updated scope, and in-slice rationale in the next auxiliary check's prior-round correction fields. Preserve every earlier check and correction claim.

## EXECUTE_SLICE

Require an open, dependency-ready current-authority slice with approved plans and materialized tasks. Implement only its checklist. Update local checklist items, canonical normalized `Changed Areas` path claims, discovered expansion, divergences, and a compact diff summary. Persist every divergence under local `references/execution-record-schema.md`; newly detected blocking divergences are `Severity: blocking`, `State: active`, and direct first to lifecycle `RESUME` when documentary authority must change, then to `REPLAN`. The executor never resolves or supersedes a divergence. Then delegate checks automatically and append the result under `Implementation Test Evidence` as the next `implementation-check-NN`, including status, tested state, commands and numeric exit codes, selected tests, selection rationale, coverage, compact evidence or failure summary, blockers, unexpected workspace effects, and persistence summary.

Compare every changed path with the Effective Validation Bases of earlier completed slices. Record each overlap under `Prior Validation Overlap` with the earlier slice, affected behavior, and regressions the current validation must justify. Include the path in the current slice's changed areas. Do not reopen or rewrite an earlier slice.

On `TESTS_FAIL` before the third round, apply only an objectively supported in-scope correction, update changed scope, record the correction, and invoke the runner again within the same `EXECUTE_SLICE`. If that correction is not authorized, append the applicable active blocking divergence and stop. On the third `TESTS_FAIL`, persist evidence, enter `IMPLEMENTATION_RETRY_EXHAUSTED`, and report explicit `VALIDATE_SLICE` as the only next slice action; do not correct again or permit executor re-entry. On `TESTS_NOT_APPLICABLE`, persist discovery sources, relevant read-only discovery actions, verification types considered, objective rationale, and confirmation that no verification command was executed. On `BLOCKED`, record the cause and required action and enter `AUXILIARY_BLOCKED`. Every status leaves the slice open and formal validation pending; no check creates a formal finding or invokes another operation automatically.

## APPLY_FINDINGS

Require at least one persisted active blocking finding in `VALIDATION_NEEDS_FIX`, and reject retry-exhausted or already-corrected phases. Read active findings, the selected plan and task record, affected code and tests, and necessary requirements. Correct only reported problems and their necessary effects. Add every final affected or removed path to canonical `Changed Areas` and `Corrections Applied`; persist finding IDs and correction details in the findings-check evidence, and record newly discovered prior-slice overlap. Preserve all finding records, Validation Attempts, and any historical Effective Validation Base until later formal validation; correction and auxiliary checks never change finding state.

Then delegate checks automatically and append the result under `Findings Test Evidence` as the next `findings-check-NN`, associated with the applicable findings cycle. In addition to the common check evidence, record findings verified, corrections covered, regressions selected, and findings not yet supported by tests.

On `TESTS_FAIL` before the third round, adjust only persisted active findings, failures introduced or exposed by their corrections, directly related regressions, and necessary effects inside approved scope. Update corrections and changed scope, record the between-round correction, and invoke the runner again within the same `APPLY_FINDINGS`. On the third `TESTS_FAIL`, persist evidence, leave every previously active finding active while preserving historical states, enter `FINDINGS_RETRY_EXHAUSTED`, and report explicit `VALIDATE_SLICE` as the only next slice action; do not correct again or permit executor re-entry. On `TESTS_NOT_APPLICABLE`, persist objective discovery, relevant read-only discovery actions, verification types considered, rationale, and confirmation that no verification command was executed without resolving findings. On `BLOCKED`, preserve cause and required action and enter `AUXILIARY_BLOCKED`. Do not perform formal validation, mark completion, set final result, replace prior Validation Attempts or Effective Validation Base, or invoke `VALIDATE_SLICE` automatically. If correction requires a requirement, scope, dependency, or strategy change, append an active blocking divergence and direct first to lifecycle `RESUME` when needed and then explicit `REPLAN`.

## Allowed Effects

- modify implementation and tests inside the selected scope;
- after implementation or correction, invoke the configured independent runner at least once and no more than three times in the selected manual operation;
- update only execution-owned sections of `tasks/slice-NN.md`, including the appropriate append-only test-evidence section.
- use temporary support files only in an external operating-system temporary directory; never create scratch files, scripts, manifests, or ad hoc reports inside the SPEC or execution root.

## Blocks

Block missing or invalid inputs, absent artifacts, incomplete dependencies, stale requirements authority, a concluded slice, an active blocking divergence, either retry-exhausted state, out-of-scope work, a required planning/requirements decision, a non-canonical execution path or unsafe reserved SPEC entry reported by preflight, unavailable or malformed runner behavior after the bounded transport policy and objective persistence above, or an attempt to mutate plans, the global task index, another slice, or a concluded slice. Arbitrary lifecycle-external or user-owned SPEC-root siblings are allowed and preserved. Report each blocking path exactly and require relocation or explicit removal; never delete it automatically.

## Output

Report operation, selected slice, changed areas, delegated-check status and evidence location, divergences, and the next appropriate explicit action. Stop.
