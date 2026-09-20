# S3 Autonomous Benchmark Convergence

## Base

- Branch: `feature/atlas-p0`
- Base SHA: `a98754cf2eea8329d9af246e77fc39417d5c63af`
- Base parent: `84ea82fef528487b0d3b0472def1199c277b340e`
- Base commit: `docs(benchmark): record Production Pilot #12 outcome`
- Published base: confirmed at `origin/feature/atlas-p0`
- Profile: `production-v2`
- Objective: converge fresh Case A, Case B, and Case C workspaces to functional PASS without weakening Sentinel authorities.
- Official baseline: `NOT_YET_ESTABLISHED`

## Initial blocker

Pilot #12 evidence is being read before diagnosis. The preserved Case A blocker is the candidate validation failure during operation 08 (`EXECUTE_SLICE slice-02`) after the auxiliary runner returned `TESTS_PASS` round `1/3`; official execution remained `EXECUTION_STARTED` and live state was not published.

## Issue ledger

### C01 — Historical overlap rejected by candidate evidence check

- Category: `VALIDATION_OWNERSHIP`
- Case: A
- Operation: 08, `EXECUTE_SLICE`
- Slice: `slice-02`
- Symptom: The candidate containing a completed `slice-02` implementation was rejected before publication because the validator compared `slice-01`'s historical `Effective Validation Base` hash with the file's new physical bytes.
- Official state: `EXECUTION_STARTED`
- Evidence: Pilot #12 operation artifact reports `TESTS_PASS` round `1/3` followed by candidate validation `BLOCKED` exit `1`, naming `slice-01.md` and `test/cli.test.mjs`; deterministic regression failure is preserved at `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c01-overlap-regression-before-fix.json`.
- Root cause: `validateCandidateExecutionRecordPaths` iterated every task base and required every historical file-backed hash to match the current physical workspace. The runtime already treats final ownership as the latest PASS owner per path, but candidate validation did not distinguish immutable historical evidence from the current evidence being published.
- Files/components responsible: `skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs` (byte-identical copies are bundled into the execution skills); `scripts/test-execution-contract.mjs` regression.
- Correction: `validateCandidateExecutionRecordPaths` now computes the latest candidate evidence owner for each path in serial order. It keeps canonical path/containment checks for every entry, compares the physical hash only for the latest owner, and never changes historical manifests.
- Regression added: `candidate validation permits declared later-slice ownership of a historical overlap` (fails before the correction at the historical hash comparison; also asserts current `slice-02` evidence remains strict).
- Local checks: Before correction, the focused regression failed with the expected historical-hash diagnostic. After correction, the focused regression passed; `node --test scripts/test-execution-contract.mjs` passed (99 tests); `node --test scripts/test-benchmark-rehearsal.mjs` passed (10 tests).
- Live replay: Fresh controlled Case A replay passed after the fix: 11 operations, `COMPLETE`, SPEC closed, final tests PASS, profile mismatches `[]`, outer retry `0`; compact evidence is at `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c01-case-a-replay-summary.json`. The replay reached `EXECUTE_SLICE slice-02` and advanced through terminal close.
- Result: Local blocker eliminated; current evidence remains strict and live replay is required to prove integration.
- Workflow progress: Deterministic candidate validation now advances the overlap case to `IMPLEMENTED_AWAITING_VALIDATION`.
- Live model calls consumed: 11 in the corrected functional replay. A separate initial setup-only replay call consumed 1 additional `SPEC_INIT` call before the temporary glue was corrected; it is recorded in the live-call ledger.

### C02 — Detailed-plan path basis was reused during task materialization

- Category: `PATH_BASIS`
- Case: C
- Operation: 04, `MATERIALIZE_TASKS`
- Slice: none
- Symptom: The approved planning set reached `PLANNED_READY`, but materialization blocked before publishing tasks because a detailed-plan implementation claim was reused with the wrong artifact-relative basis.
- Official state: `PLANNED_READY`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c02-case-c-path-basis-blocker.json`; the preserved operation output reported `../../../src/validation.mjs` from `execution/tasks/slice-01.md` resolving to `specs/src/validation.mjs`; tasks were not materialized and `REPLAN` was legal.
- Root cause: The model-authored detailed plan used the global-plan path basis for a plan under `execution/plans/`; materialization correctly rebased the claim from the declaring detailed plan and then strict candidate validation rejected the resulting task path. This is a producer path-basis violation, not a validator false negative.
- Files/components responsible: model-authored planning/task path carriers governed by `stnl-execution-planner` and `stnl-task-materializer`; strict path validation in the distributed execution runtime.
- Correction: No authority or validator relaxation. The legal `REPLAN` handoff was resumed with the exact path-basis diagnostic and the required mechanical `path.relative(dirname(tasks/slice-NN.md), physicalTarget)` rule.
- Regression added: Existing deterministic path-basis contracts were re-run: `Pilot #11 planning claims use the containing artifact basis`, `artifact-relative planning paths reject lifecycle-local candidates before publication`, and `materializer rebases PLAN claims from the official execution workspace for every SPEC_PATH form`.
- Local checks: All three path-basis regressions passed; strict invalid paths remain rejected.
- Live replay: The fresh C replay after the path-basis recovery reached `MATERIALIZE_TASKS: PASS`; the next blocker was a distinct `EXECUTE_SLICE slice-01` auxiliary handoff failure recorded as C05. The path-basis blocker did not recur.
- Result: Initial blocker eliminated without weakening containment or path validation.
- Workflow progress: The workflow advanced from `PLANNED_READY` through successful materialization and review into slice execution.
- Live model calls consumed: 4 in the blocked attempt; recovery calls are recorded separately in the live-call ledger.

### C03 — Formal validation producer did not preserve canonical authority identity

- Category: `PRODUCER_CONTRACT`
- Case: B
- Operation: 09, `VALIDATE_SLICE`
- Slice: `slice-02`
- Symptom: After `EXECUTE_SLICE slice-02` passed candidate validation with authority `sha256:a199...69e26`, formal validation persisted `attempt-01` as `BLOCKED` after reporting a different current authority (`sha256:70b880...a4a20`).
- Official state: `VALIDATION_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c03-case-b-validation-authority-blocker.json`; the official readback retained the preflight and plan authority `sha256:a199...69e26`, no finding or Effective Validation Base mutation, and legal recovery `VALIDATE_SLICE slice-02`/`REPLAN`.
- Root cause: The validation launcher did not repeat the caller-side guard that the execution launchers already use: copy the exact `authority=sha256:<64hex>` from the same official preflight and forbid raw/reconstructed hashes of `shared/requirements.md` or `feature_spec.md`. The runner contract itself already contains this rule; the caller payload lacked an equally explicit producer guard, allowing a formal validation attempt to be blocked on a non-canonical authority comparison.
- Files/components responsible: `templates/prompts/slice-validate-codex.md`, `templates/prompts/slice-validate-claude.md`, and launcher contract coverage.
- Correction: Add the exact preflight-authority identity and raw-hash prohibition to both validation launchers and require it in `scripts/check-contracts.mjs`, with mutation coverage in `scripts/test-launcher-contract.mjs`. Validators remain strict and a mismatched producer value still blocks.
- Regression added: Launcher contract regressions will assert removal of the canonical authority identity or reintroduction of raw authority hashing is rejected as `L026_AUTHORITY_IDENTITY`.
- Local checks: `node --test scripts/test-launcher-contract.mjs` passed 92 tests after C03; `node --test scripts/test-validation-runner-contract.mjs` passed 95 tests.
- Live replay: The affected B replay passed through terminal close: 13 operations, `COMPLETE`, formal validation for all 3 slices, and no profile mismatch. That replay began before C04 and is evidence for C03 only; final fresh proof remains required.
- Result: Initial formal validation blocker eliminated; no false PASS was published during the blocked attempt.
- Workflow progress: Case B reached and passed `EXECUTE_SLICE slice-02` before the new blocker.
- Live model calls consumed: 9 in the blocked replay; the full call ledger records each operation.

### C04 — Formal validation output omitted the complete official preflight command

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 09, `VALIDATE_SLICE`
- Slice: `slice-02`
- Symptom: The independent validation result claimed `PASS`, but the formal output omitted the exact official preflight command from `Comandos executados`; the owner correctly persisted a malformed-output delegation blocker instead of publishing an attempt or base.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c04-case-c-malformed-validation-output.json`; authority was canonical (`sha256:8feab...da00a8`), no attempt/base/finding/global-row mutation occurred, and the mandatory same-operation recovery was `VALIDATE_SLICE slice-02`.
- Root cause: The validation launcher did not repeat the exact-command requirement at the caller boundary, even though the runner contract and runtime require complete commands including the official preflight. The producer emitted an incomplete formal record; the fail-closed malformed-output path was correct.
- Files/components responsible: `templates/prompts/slice-validate-codex.md`, `templates/prompts/slice-validate-claude.md`, and launcher contract coverage.
- Correction: Add an explicit caller instruction that `Comandos executados` must contain the complete absolute official preflight command with `SPEC_PATH`, operation, slice, and numeric exit code; require the guard in `scripts/check-contracts.mjs` and mutation-test it.
- Regression added: Launcher contract regression for removal of the complete preflight-command requirement, classified `L020_EXACT_COMMANDS`.
- Local checks: Pending focused contract run after this correction.
- Live replay: The fresh C replay after this correction reached `EXECUTE_SLICE slice-01` but encountered C05 first, so C04 still requires a fresh C proof after C05.
- Result: No false formal PASS was accepted; the malformed producer output was preserved as a blocker.
- Workflow progress: C reached `VALIDATE_SLICE slice-02` after two slices passed execution/validation and C03 authority identity was corrected.
- Live model calls consumed: 9 in this blocked replay; every call remains in the final ledger.

### C05 — Execute runner received paths absent from the delegated session

- Category: `HANDOFF`
- Case: C
- Operation: 06, `EXECUTE_SLICE`
- Slice: `slice-01`
- Symptom: The official preflight was `PASS` in `MATERIALIZED_PRISTINE`, but the auxiliary runner returned `BLOCKED` round `1/3` before running any verification command because the supplied `SPEC_PATH`, execution root, plan path, and task path did not exist in the delegated session.
- Official state: `AUXILIARY_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c05-case-c-execute-slice-01.json` and the preserved task artifact at `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c05-case-c-execute-slice-01/task-slice-01.md`; preflight, harness, authority, and same-operation recovery fields are preserved in the external replay summary referenced by the compact artifact.
- Root cause: The execution producer constructed an invalid runner handoff path set. The runner contract correctly failed closed; this was not a candidate-validator, sandbox, environment, or authority failure. The generic executor contract required a derived execution root but did not explicitly require the producer to resolve and existence-check every concrete delegated path against the same managed workspace before spawn.
- Files/components responsible: `templates/prompts/slice-execute-codex.md`, `templates/prompts/slice-execute-claude.md`, the generic `stnl-slice-executor` delegation contract, and launcher contract coverage.
- Correction: Pending at issue registration: add a platform-neutral pre-spawn path identity/availability guard requiring one canonical existing `SPEC_PATH`, derived execution root, plan path, and task path from the same official preflight and managed workspace; never forward host, source-checkout, candidate, relative, placeholder, or reconstructed paths.
- Regression added: Pending at issue registration; the deterministic launcher contract will reject removal of the execution handoff path guard.
- Local checks: Pending C05 correction.
- Live replay: Fresh C stopped at operation 06 with `OFFICIAL_AUXILIARY_BLOCKED`; required recovery is same-operation `EXECUTE_SLICE slice-01`, record `implementation-check-01`, round `1`.
- Result: New blocker preserved before correction; no verification result, formal attempt, or false PASS was published.
- Workflow progress: C02 was eliminated and C advanced through materialization/review; C05 is the current blocker.
- Live model calls consumed: 6 in the fresh C replay; the live-call ledger records operations 01 through 06.

### C08 — Auxiliary runner compared non-canonical raw requirements authority

- Category: `AUXILIARY_RUNNER`
- Case: C
- Operation: 06, `EXECUTE_SLICE`
- Slice: `slice-01`
- Symptom: On a later fresh C workspace, task paths and canonical `Requirements authority` were correct, but the auxiliary runner returned `BLOCKED` before checks because it compared the producer against a separately computed raw requirements digest.
- Official state: `AUXILIARY_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c08-case-c-execute-slice-01-raw-authority.json` and its preserved task artifact; the task record states canonical task-relative paths and the official authority.
- Root cause: The runner producer violated the existing authority contract by treating a raw requirements-file digest as comparable authority. Official preflight and selected artifacts agreed; the fail-closed owner correctly did not create a check or documentary divergence.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, and the execution caller/runner authority instructions.
- Correction: Add a high-salience runner guard that only the exact official preflight authority and its equality with payload/artifact may decide authority consistency; raw hashes of `shared/requirements.md` or `feature_spec.md` are non-authoritative and cannot create a blocker. Preserve strict mismatch handling and no fallback.
- Regression added: Pending C08 correction; runner and execution-launcher contract mutations will reject any raw-authority comparison or removal of the official-only guard.
- Local checks: Pending C08 correction.
- Live replay: Fresh C stopped at operation 06; this is distinct from C05 because the path basis was canonical and the cause was raw authority comparison.
- Result: New blocker preserved before correction; no verification, correction, or false PASS was published.
- Workflow progress: The previous fresh C had reached terminal close before C07; this new fresh workspace exposed a separate auxiliary authority producer defect.
- Live model calls consumed: 6 in this fresh C replay; the live-call ledger records operations 01 through 06.

### C06 — Auxiliary `TESTS_PASS` used repository-relative Tested state paths

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 10, `EXECUTE_SLICE`
- Slice: `slice-03`
- Symptom: The auxiliary runner returned `TESTS_PASS`, but its file-backed `Tested state` used `src/cli.mjs` and `test/cli.test.mjs` instead of the required task-relative claims; the owner persisted `RUNNER_RESULT_BLOCKED` and did not create an implementation check.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c06-case-c-execute-slice-03.json` and the preserved task artifact at `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c06-case-c-execute-slice-03/task-slice-03.md`; the task itself states the required canonical claims `../../../../src/cli.mjs` and `../../../../test/cli.test.mjs`.
- Root cause: The auxiliary producer ignored the existing task-relative path contract on a one-task final slice. The runtime correctly rejected the malformed evidence without rebasing it. The existing contract was semantically correct but not sufficiently salient at the runner return boundary for this live producer.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, `templates/prompts/slice-execute-codex.md`, `templates/prompts/slice-execute-claude.md`, `skills/workflows/stnl-slice-executor/SKILL.md`, and their contract regressions.
- Correction: Add a concise pre-return runner guard that mechanically recomputes every file-backed `Tested state` claim from `dirname(tasks/slice-NN.md)`, explicitly rejects `src/...`, `test/...`, absolute, workspace-relative, and repository-relative forms, and forbids rebase/acceptance. Add the same caller-side guard before accepting an auxiliary status. No runtime hash/path relaxation was added.
- Regression added: `scripts/test-validation-runner-contract.mjs` now rejects removal of the pre-return task-relative guard as `R021_PATH_BASIS`; `scripts/test-launcher-contract.mjs` rejects removal of the caller-side guard as `L028_TESTED_STATE_PATHS`.
- Local checks: Focused launcher contracts passed 96 tests; validation-runner contracts passed 96 tests.
- Live replay: Fresh C reached `EXECUTE_SLICE slice-03` after C05 and C04 were eliminated, then stopped at this malformed output. A fresh C replay after this correction is required.
- Result: New blocker preserved before correction; strict fail-closed behavior was confirmed.
- Workflow progress: C reached terminal-slice execution after two slices had passed execution and formal validation.
- Live model calls consumed: 10 in the blocked fresh C replay; the live-call ledger records each operation.

### C07 — SPEC_CLOSE model turn failed after execution COMPLETE

- Category: `OTHER`
- Case: C
- Operation: 13, `SPEC_CLOSE`
- Slice: none
- Symptom: After all three slices had execution/validation `PASS`, `SPEC_READINESS` was `PASS` and execution state was `COMPLETE`, the close harness returned `MODEL_TURN_FAILED` with no assistant message and no command exit codes; official lifecycle state remained `ready`/`closed=false`.
- Official state: `COMPLETE` for execution; lifecycle close remained unpublished.
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c07-case-c-spec-close-model-turn.json`; operation evidence records `sessionStarted=true`, `turnStarted=true`, empty assistant output, and no source mutation.
- Root cause: The evidence proves a harness/provider turn failure but exposes no more specific provider diagnostic. It is distinct from the workflow blockers C01-C06 and does not establish a source or authority defect.
- Files/components responsible: No repository source component is implicated by the preserved evidence; controlled replay harness/model turn only.
- Correction: No source correction. Continue with a fresh official `SPEC_CLOSE` attempt as part of the required fresh convergence proof; do not add an outer retry or alter state authority.
- Regression added: Not applicable; no deterministic repository defect was established.
- Local checks: No source change was made for C07.
- Live replay: C reached `SPEC_READINESS: PASS` and stopped only at close; a fresh C replay is required to prove terminal lifecycle closure.
- Result: Execution convergence was preserved; lifecycle closure was not yet proven in this replay.
- Workflow progress: C reached `COMPLETE` and terminal readiness before the model-turn failure.
- Live model calls consumed: 13 in this replay, including the failed `SPEC_CLOSE` call; the live-call ledger records all operations.

### C09 — Runner did not resolve Tested state from the task artifact

- Category: `PATH_BASIS`
- Case: C
- Operation: 06, `EXECUTE_SLICE`
- Slice: `slice-01`
- Symptom: After the C08 correction, the runner no longer reported the raw-authority blocker, but returned `BLOCKED` because file-backed `Tested state` claims `../../../src/validation.mjs` and `../../../test/todo-store.test.mjs` resolved from `dirname(tasks/slice-01.md)` to `specs/src` and `specs/test`, not to the physical project targets.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c09-case-c-execute-slice-01-task-relative-resolution.json` and its preserved task artifact; the official authority was `sha256:c16ab980e94f84cc70348308f631cad48eede997236a81a3313154afe57a9624`, and the task's canonical claims were `../../../../src/validation.mjs` and `../../../../test/todo-store.test.mjs`.
- Root cause: The live runner still derived the output path from a higher-level SPEC/plan basis, omitting one parent relative to the selected task artifact. The existing fail-closed rule identified the malformed output, but the producer contract did not make the final `realpath(dirname(taskArtifact) + claim) === realpath(target)` identity check sufficiently explicit to this model turn.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, `templates/prompts/slice-execute-codex.md`, `templates/prompts/slice-execute-claude.md`, `skills/workflows/stnl-slice-executor/SKILL.md`, and their contract coverage.
- Correction: Pending at issue registration. Add a generic physical-identity check after deriving each task-relative claim: resolve it from the selected task artifact, compare its real target, and return malformed `BLOCKED` rather than emitting `TESTS_PASS` when the result differs. Do not rebase or repair a producer claim in the runtime.
- Regression added: Pending at issue registration; add runner and executor contract mutations for removal of the physical-resolution check.
- Local checks: Pending C09 correction.
- Live replay: Fresh C reached operation 06 after `SPEC_INIT`, `PLAN`, `REVIEW_PLAN`, `MATERIALIZE_TASKS`, and `REVIEW_TASKS` passed. This is a distinct blocker from C08: the raw-authority mismatch did not recur, and the state advanced from `AUXILIARY_BLOCKED` to `RUNNER_RESULT_BLOCKED`.
- Result: C08 correction produced objective progress and exposed C09; no false PASS or implicit path rebase was accepted.
- Workflow progress: C advanced five operations before the new malformed-output blocker.
- Live model calls consumed: 6 in this fresh C replay; the live-call ledger records operations 01 through 06.

### C10 — SPEC_INIT published an unresolved blocking question

- Category: `OTHER`
- Case: C
- Operation: 01, `SPEC_INIT`
- Slice: none
- Symptom: A fresh C workspace published a lifecycle SPEC with `status=blocked` because `Q-001` remained open for the canonical representation of `archived=false`; official execution stayed `EMPTY` and exposed no legal operation.
- Official state: `EMPTY` (lifecycle `blocked`)
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c10-case-c-spec-init-blocked-question.json`; the harness completed normally, official validation reported `PASS` for 21 IDs, and readback reported `blockingQuestions=[Q-001]`, `legalOperations=[]`, and no provider error.
- Root cause: The live SPEC producer left a blocking domain decision unresolved instead of publishing a ready lifecycle authority. The preserved evidence does not implicate the runtime, path basis, authority comparison, environment, or driver state machine.
- Files/components responsible: No repository source component is proved responsible; this is a producer/model-output nondeterminism in the fresh replay.
- Correction: No source correction. A new fresh workspace is required because the official state exposes no legal recovery; no question was silently resolved and no authority was weakened.
- Regression added: Not applicable; no deterministic repository defect was established.
- Local checks: No source change was made for C10.
- Live replay: The replay stopped at operation 01 with outer retry `0`; this is independent of the C09 path-basis blocker.
- Result: Strict lifecycle blocking was preserved; functional convergence was not advanced in this workspace.
- Workflow progress: None in this replay; prior C09 replay had already advanced through `REVIEW_TASKS`.
- Live model calls consumed: 1 (`SPEC_INIT`, `GPT-5.6-Sol`, `high`).

### C11 — Formal validation runner returned a truncated manifest hash

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 09, `VALIDATE_SLICE`
- Slice: `slice-02`
- Symptom: The validation runner returned `PASS`, but its formal manifest contained a 47-hex-character digest for `../../../../test/todo-service.test.mjs` instead of the required lowercase 64-hex SHA-256 token.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c11-case-c-validate-slice-02-truncated-hash.json` and the preserved task artifact; the official preflight command was complete and exited 0, while no Validation Attempt or Effective Validation Base was created.
- Root cause: The validation runner output violated the existing exact digest contract. The owner correctly rejected the malformed output; the runtime did not recompute, repair, or accept the truncated hash.
- Files/components responsible: `templates/prompts/slice-validate-codex.md`, `templates/prompts/slice-validate-claude.md`, `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, and contract coverage.
- Correction: Pending at issue registration. Add a high-salience validation/runner rule that every file-backed manifest and Tested state digest must be copied from a read-only hash result as exactly `sha256:` plus 64 lowercase hexadecimal characters; if not exact, return malformed `BLOCKED` and never emit `PASS`.
- Regression added: Pending at issue registration; add launcher and runner contract mutations for removal of the exact-length digest guard.
- Local checks: Pending C11 correction.
- Live replay: C advanced through `EXECUTE_SLICE`/`VALIDATE_SLICE` for slice 01 and execution/validation for slice 02 before stopping at operation 09; outer retry `0`.
- Result: Strict hash validation held; no false formal PASS was published.
- Workflow progress: C reached its first formal validation blocker after nine operations, beyond all prior C09/C10 points.
- Live model calls consumed: 9 in this fresh C replay; the live-call ledger records operations 01 through 09.

### C12 — Materializer omitted the global task-index File Purpose Header

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 04, `MATERIALIZE_TASKS`
- Slice: none
- Symptom: The materializer candidate was rejected because `execution/tasks.md` lacked the required seven-field File Purpose Header; no live execution artifact was published.
- Official state: `PLANNED_READY`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c12-case-c-materialize-missing-task-index-header.json`; preflight was PASS, the isolated candidate was removed, and no retry or partial publication occurred.
- Root cause: The materializer producer omitted a machine-authoritative header required by the existing task-index template and runtime parser. This is a producer contract failure, not a runtime false negative.
- Files/components responsible: `templates/prompts/execution-tasks.md`, `skills/workflows/stnl-task-materializer/SKILL.md`, and materializer launcher contract coverage.
- Correction: Pending at issue registration. Add a high-salience prepublication guard requiring the exact global `tasks.md` File Purpose Header from `tasks.template.md` and exact pristine task headers before candidate validation/publication; missing or altered headers must remain blocked.
- Regression added: Pending at issue registration; add launcher contract mutation coverage for the global task-index header guard.
- Local checks: Pending C12 correction.
- Live replay: C advanced through `REVIEW_PLAN`, then stopped at materialization; the official recovery `REPLAN` returned `PLANNED_DRAFT`, so `REVIEW_PLAN` is required before a legal materialization retry.
- Result: Strict header authority held and no partial task set was published; the controlled replay did not yet prove whether the producer correction passes.
- Workflow progress: Four normal operations plus one official replan recovery were consumed; execution did not start.
- Live model calls consumed: 5 (`SPEC_INIT`, `PLAN`, `REVIEW_PLAN`, failed `MATERIALIZE_TASKS`, recovery `REPLAN`).

### C13 — Execute runner returned a truncated Tested state digest

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 06, `EXECUTE_SLICE`
- Slice: `slice-01`
- Symptom: After C12 materialization passed, the execute runner returned malformed file-backed `Tested state` evidence with a non-64-character digest for `../../../../test/todo-store.test.mjs`; no implementation check was allocated.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c13-case-c-execute-slice-01-truncated-hash.json` and its preserved task artifact; the official authority was canonical and outer retry was `0`.
- Root cause: The C11 correction made the exact digest rule explicit for formal validation, but the execution caller still relied on a lower-salience hash instruction. The producer emitted malformed `Tested state` evidence; strict ownership rejected it.
- Files/components responsible: `templates/prompts/slice-execute-codex.md`, `templates/prompts/slice-execute-claude.md`, `skills/workflows/stnl-slice-executor/SKILL.md`, and execution launcher contract coverage.
- Correction: Pending at issue registration. Add the same high-salience exact `sha256:` plus 64 lowercase hex guard before accepting execute-runner `TESTS_PASS`; malformed output remains `BLOCKED` without recomputation or repair.
- Regression added: Pending at issue registration; add executor launcher mutation coverage for removal of the exact digest guard.
- Local checks: Pending C13 correction.
- Live replay: C passed through materialization and task review, then stopped at operation 06; no implementation check, formal validation, or source publication followed.
- Result: C12 was eliminated and C13 was exposed; strict digest identity remained intact.
- Workflow progress: C reached `MATERIALIZED_PRISTINE` and `REVIEW_TASKS` PASS before the new execute blocker.
- Live model calls consumed: 6 in this fresh C replay; the live-call ledger records operations 01 through 06.

### C14 — Execute caller treated raw authority evidence as a blocker again

- Category: `AUXILIARY_RUNNER`
- Case: C
- Operation: 06, `EXECUTE_SLICE`
- Slice: `slice-01`
- Symptom: After C13's digest-format correction, the execute producer again reported a raw requirements-file digest as an authority divergence and returned non-canonical auxiliary output, despite official preflight, payload, and selected artifact carrying the same canonical token.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c14-case-c-execute-slice-01-raw-authority-recurrence.json` and its preserved task artifact; official authority was `sha256:556920f531f150e8dae1ec2140e0fbf1ff99b6dd53046176fcd67b0a457e4509`.
- Root cause: The caller-side result disposition did not make the non-authoritative status of any raw digest sufficiently operational: when the three official tokens agree, a raw digest must be ignored and cannot create a divergence or blocker. This is distinct from C13's malformed hash length.
- Files/components responsible: `templates/prompts/slice-execute-codex.md`, `templates/prompts/slice-execute-claude.md`, `skills/workflows/stnl-slice-executor/SKILL.md`, and execute launcher contract coverage.
- Correction: Pending at issue registration. Add an explicit caller result-disposition rule: discard any raw requirements digest observed in runner output when official tokens agree; only official-token inequality can block authority, while malformed runner schema remains strict `RUNNER_RESULT_BLOCKED` for its actual schema defect.
- Regression added: Pending at issue registration; add executor launcher mutation coverage for re-enabling raw-digest authority blocking.
- Local checks: Pending C14 correction.
- Live replay: C passed through materialization and task review and stopped at operation 06; outer retry `0`.
- Result: C13 did not recur; C14 exposed the remaining caller disposition defect without any authority relaxation.
- Workflow progress: C reached `MATERIALIZED_PRISTINE`/`REVIEW_TASKS` PASS before the raw-authority recurrence.
- Live model calls consumed: 6 in this fresh C replay; the live-call ledger records operations 01 through 06.

### C15 — Formal validation runner abbreviated the concrete SPEC_PATH

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 09, `VALIDATE_SLICE`
- Slice: `slice-02`
- Symptom: The validation runner returned `PASS`, but its `Comandos executados` evidence abbreviated the concrete `SPEC_PATH` with `...`; the caller correctly classified the response as malformed and did not create a Validation Attempt.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c15-case-c-validate-slice-02-abbreviated-spec-path.json`, the preserved blocker-relevant task artifact, and the operation evidence referenced there. The official authority was `sha256:57245dbba39512271a2c4ca14a5316051c020c3ce199851b58aa2d5391eb7062`.
- Root cause: The runner had a general no-ellipsis rule, but no high-salience write-back guard requiring the exact full payload `SPEC_PATH` to be copied into the formal command line before returning `PASS`. The strict caller/runtime behavior is correct; the producer output contract was not operationally explicit enough for this live turn.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, and validation-runner contract coverage.
- Correction: Pending at issue registration: add a final `VALIDATE_SLICE` output guard requiring the complete official preflight command, including the exact full payload `SPEC_PATH`, operation, slice, and numeric exit code; any omitted, shortened, placeholder, or ellipsis path remains malformed `BLOCKED`.
- Regression added: First add a deterministic validation-runner contract mutation that fails if this exact payload-path write-back guard is removed; then apply the minimal contract/checker correction and rerun it.
- Local checks: Pending C15 correction.
- Live replay: Fresh C advanced through `VALIDATE_SLICE slice-02` after C14 was eliminated and stopped at this new malformed-output blocker; outer retry `0`.
- Result: C14 was eliminated and C progressed from operation 06 to operation 09; no false formal PASS was published.
- Workflow progress: Objective progress beyond the prior blocker; the next legal action is the same `VALIDATE_SLICE slice-02` recovery on a fresh workspace after the producer contract correction.
- Live model calls consumed: 9 in this replay; the live-call ledger records operations 01 through 09.

### C16 — PLAN producer rejected its own Requirements source as non-canonical

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 02, `PLAN`
- Slice: none
- Symptom: `SPEC_INIT` returned `PASS`, but the PLAN producer returned `BLOCKED` with `plan.md has non-canonical Requirements source` and published no plan artifact.
- Official state: `EMPTY` with lifecycle `ready`; `PLAN` remained the only legal operation.
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c16-case-c-plan-noncanonical-requirements-source.json`, including the operation evidence and official readback. No candidate publication, retry, or source mutation occurred.
- Root cause: The live PLAN producer rejected the Requirements source before transition; the preserved evidence does not prove a repository source, runtime-authority, or driver defect. The state has no recovery artifact to resume, so a fresh workspace is the only legal probe.
- Files/components responsible: No repository component is proven responsible; the evidence identifies a model-produced PLAN result.
- Correction: No source correction. Perform one fresh Case C replay. If the same point and diagnostic recur, stop with `BLOCKED_NO_OBJECTIVE_PROGRESS` as required.
- Regression added: Not applicable; no deterministic repository defect was established.
- Local checks: No source change for C16.
- Live replay: Fresh C stopped at operation 02 after `SPEC_INIT` PASS; outer retry `0`.
- Result: Distinct blocker; the workflow did not reach C15's point in this workspace.
- Workflow progress: No progress beyond `SPEC_INIT` in this replay; the preceding C replay had advanced to operation 09, so this is a fresh-producer nondeterminism, not a regression of C15.
- Live model calls consumed: 2 (`SPEC_INIT` and `PLAN`, both `GPT-5.6-Sol`, `high`).

### C17 — Planner repeated a higher-level path basis in a detailed plan

- Category: `PATH_BASIS`
- Case: C
- Operation: 04, `MATERIALIZE_TASKS`
- Slice: none
- Symptom: The approved plan reached `PLANNED_READY`, but candidate validation rejected `slice-01` claim `../../../src/validation.mjs`: resolved from `plans/slice-01.md` it pointed to `specs/src/validation.mjs`, not the physical project target. No task index or task files were published.
- Official state: `PLANNED_READY`, then `PLANNED_DRAFT` after the official `REPLAN` recovery.
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c17-case-c-materialize-plan-claim-path-basis-recurrence.json` and the managed replay operation evidence referenced there.
- Root cause: The planner producer emitted a detailed-plan path using a higher-level/global basis. The runtime and materializer correctly preserved strict artifact-relative identity and rejected the claim; the existing semantic instruction did not force a mechanical producer-side realpath/re-relative check before publication.
- Files/components responsible: `templates/prompts/execution-plan.md`, `skills/workflows/stnl-execution-planner/SKILL.md`, and planner launcher contract coverage.
- Correction: First correction added a planner pre-publication guard requiring every claim to be recomputed from its declaring artifact with `path.relative(path.dirname(artifact), physicalTarget)`, checked by `realpath`, and blocked before publication if it differs. The runtime containment and candidate validation remained strict.
- Regression added: `scripts/test-launcher-contract.mjs` now rejects removal of the planner guard as `L035_PLAN_PATH_IDENTITY`; focused mutation failed before the guard and passed after it.
- Local checks: Focused launcher contract passed 103 tests after the planner correction; repository checker passed for launchers.
- Live replay: The fresh C replay after the planner-only correction still stopped at `MATERIALIZE_TASKS` with the same claim and same diagnostic; compact recurrence evidence is `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c17-recurrence-after-planner-guard.json`. The official recovery `REPLAN` returned `PLANNED_DRAFT` without tasks.
- Result: The first correction did not eliminate C17. This is the second causal correction attempt: extend the same physical identity guard to independent `REVIEW_PLAN` approval, without changing runtime acceptance or path semantics.
- Workflow progress: The replay reached `REVIEW_PLAN PASS` before the repeated blocker; no implementation or validation call.
- Live model calls consumed: 5 in this replay, including the recovery `REPLAN`; the live-call ledger records all calls.

### C18 — Validation runner omitted the official preflight command

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 07, `VALIDATE_SLICE`
- Slice: `slice-01`
- Symptom: The runner returned `PASS`, but omitted the complete official execution validator/preflight invocation from `Comandos executados`; the caller correctly persisted `RUNNER_RESULT_BLOCKED` and no Validation Attempt or Effective Validation Base was created.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c18-case-c-validate-slice-01-omitted-preflight-command.json` and its referenced operation evidence. The official authority was `sha256:c5dd0e20e9d5b328554e178941ab782b25e06d0d26d6b641dd815ee2e7cf1937`.
- Root cause: The runner had a general exact-command/no-ellipsis rule and the caller had a preflight-command rule, but no high-salience runner output guard made the official command a mandatory field before `PASS`; the producer omitted the entire command while the strict owner failed closed.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, and validation-runner contract coverage.
- Correction: Pending at issue registration: require the first formal command-evidence item to be the exact official preflight invocation actually run, including executable path, full `SPEC_PATH`, operation, slice, and numeric exit code; absent or incomplete command evidence remains malformed `BLOCKED`.
- Regression added: First add a deterministic validation-runner contract mutation for removal of this mandatory official-command item; then apply the minimal runner/checker correction.
- Local checks: Pending C18 correction.
- Live replay: Fresh C advanced through `EXECUTE_SLICE slice-01 PASS` and stopped at `VALIDATE_SLICE slice-01`; outer retry `0`.
- Result: C17 was eliminated and C advanced into formal validation; C18 is a distinct runner-output schema blocker.
- Workflow progress: Seven operations reached, including one execute PASS; no formal validation attempt was published.
- Live model calls consumed: 7 in this replay; the live-call ledger records operations 01 through 07.

### C19 — Execute runner used translated auxiliary schema labels

- Category: `RUNTIME_AUTHORITY`
- Case: C
- Operation: 06, `EXECUTE_SLICE`
- Slice: `slice-01`
- Symptom: The runner returned `TESTS_PASS`, but its mandatory auxiliary record used `Escopo verificado`, `Estado testado`, `Comandos executados`, and `Testes selecionados`; the owner classified the response as malformed because the runtime parser accepts `Tested scope`, `Tested state`, `Commands`, and `Selected checks`.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c19-case-c-execute-slice-01-runner-schema-labels.json`, the preserved task artifact beside it, the replay operation evidence at `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-nez7XG/case-c/operations/06-execute_slice.json`, and the canonical parser field set in `skills/workflows/stnl-slice-executor/runtime/execution-state.mjs`.
- Root cause: The runner adapter schemas and `scripts/check-contracts.mjs` advertised translated labels that contradicted the canonical English execution-record schema and runtime parser. This is a real producer/runtime authority mismatch, not a reason to add parser aliases or relax malformed-output handling.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, `scripts/check-contracts.mjs`, and the contract round-trip regressions.
- Correction: Align both runner adapter schemas, validation-runner contract checks, validation launcher wording, and round-trip expectations with the canonical English field names already enforced by the runtime for auxiliary checks and formal attempts. Keep malformed-output rejection strict; no parser alias or hash/path relaxation was added.
- Regression added: `scripts/test-validation-runner-contract.mjs` now fails if either adapter advertises translated mandatory labels and passes only for the canonical schema; `scripts/test-execution-contract.mjs` covers the canonical runner-to-persisted-record round-trip.
- Local checks: The new regression failed before the correction; after correction `node --test scripts/test-validation-runner-contract.mjs` passed 102 tests, the focused execution round-trip tests passed, deterministic benchmark rehearsal passed R01-R05, repository and runner contract checks passed, and `git diff --check` passed.
- Live replay: Fresh C reached `EXECUTE_SLICE slice-01` after C18 correction and stopped at operation 06; outer retry `0`.
- Result: Local schema mismatch eliminated; live replay pending. C18 was not repeated; this distinct schema mismatch was exposed earlier in the workflow. No implementation check or false PASS was published.
- Workflow progress: The C replay passed `SPEC_INIT`, `PLAN`, `REVIEW_PLAN`, `MATERIALIZE_TASKS`, and `REVIEW_TASKS` before the new execute blocker.
- Live model calls consumed: 6 in this fresh C replay; the live-call ledger records operations 01 through 06.

### C20 — Fresh C SPEC_INIT model turn did not publish the SPEC

- Category: `OTHER`
- Case: C
- Operation: 01, `SPEC_INIT`
- Slice: none
- Symptom: The model turn ended after describing readiness but did not create the SPEC artifact; official readback reported `SPEC path was not created` and the driver stopped with `OFFICIAL_LIFECYCLE_BLOCKED`.
- Official state: SPEC path absent
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c20-case-c-spec-init-model-turn-failed.json` and the preserved operation evidence referenced there. The harness started one `GPT-5.6-Sol`/`high` turn; outer retry remained `0`.
- Root cause: No repository or runtime defect is proven. The producer turn terminated before publication, so there is no deterministic source correction to apply.
- Files/components responsible: None proven; official lifecycle readback and driver classification remained strict.
- Correction: None. Perform one fresh C retry; if the same point and cause recur, apply the required no-progress stop-loss.
- Regression added: Not applicable; no deterministic repository bug was established.
- Local checks: No source change.
- Live replay: Fresh C stopped at `SPEC_INIT` before operation 01 could publish; one new fresh replay is authorized.
- Result: C19 was not exercised in this attempt; no source conclusion is drawn.
- Workflow progress: No progress in this replay; the previous C replay had reached operation 06 and C19, so this is producer-turn nondeterminism.
- Live model calls consumed: 1 (`GPT-5.6-Sol`, `high`).

### C21 — PLAN producer failed closed on a non-canonical claim

- Category: `PATH_BASIS`
- Case: C
- Operation: 02, `PLAN`
- Slice: none
- Symptom: After `SPEC_INIT PASS`, the PLAN producer returned `BLOCKED` because it proposed `../../src/validation.mjs` while the mechanical recomputation required `../../../src/validation.mjs`; no plan was published and the official state stayed `EMPTY`.
- Official state: `EMPTY`, legal operation `PLAN`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c21-case-c-plan-producer-path-guard-block.json` and the replay operation evidence referenced there. The candidate validator was not invoked because the producer failed closed before publication.
- Root cause: The live model producer emitted a non-canonical plan claim. The new planner/reviewer guard behaved correctly by rejecting publication; no runtime relaxation or driver state-machine addition is justified.
- Files/components responsible: No repository component is proven responsible; the producer behavior is the observed cause.
- Correction: None for this occurrence. Run one fresh workspace probe; a repeat at the same operation with the same diagnostic will meet the no-progress stop-loss.
- Regression added: Not applicable; the source guard is already covered by the C17 planner/reviewer path-identity regressions.
- Local checks: No source change.
- Live replay: Fresh C reached `SPEC_INIT PASS`, then stopped at `PLAN`; outer retry `0`.
- Result: The path guard prevented publication of an invalid plan, but no legal recovery artifact existed.
- Workflow progress: Advanced beyond the C20 `SPEC_INIT` publication failure but did not reach C19's prior operation 06 point.
- Live model calls consumed: 2 (`SPEC_INIT` and `PLAN`, both `GPT-5.6-Sol`, `high`).

### C22 — Execute runner used an equals-sign digest delimiter

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 06, `EXECUTE_SLICE`
- Slice: `slice-01`
- Symptom: The runner returned `TESTS_PASS`, but file-backed `Tested state` used `sha256=<digest>` rather than the canonical `sha256:<64 lowercase hexadecimal>` token; the strict caller persisted `RUNNER_RESULT_BLOCKED` without creating an implementation check.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c22-case-c-execute-slice-01-sha256-equals-delimiter.json`, the compact preserved task artifact beside it, and the replay operation evidence referenced there. Official authority and outer retry were valid (`0`).
- Root cause: The runner violated the digest grammar at the delimiter level. Existing checks required the `sha256:` prefix and exact length, but did not explicitly name `sha256=` as malformed in the high-salience producer instruction.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, execute launcher/skill digest instructions, and runner contract coverage.
- Correction: Added explicit tuple grammar guards to both runner adapters, both execute launchers, and the executor skill requiring the literal `sha256:` separator and naming `sha256=`/other separators as malformed; strict caller rejection and no digest repair remain unchanged.
- Regression added: `scripts/test-validation-runner-contract.mjs` mutation coverage for removal of the literal-prefix/equals-sign rejection; `scripts/test-launcher-contract.mjs` coverage for removal of the execute caller delimiter guard.
- Local checks: The new regression failed before the correction due to the missing guard; after correction validation-runner tests passed 103 tests, launcher tests passed 105 tests, repository contract check passed, and `git diff --check` passed.
- Live replay: Fresh C reached operation 06 after `MATERIALIZE_TASKS` and `REVIEW_TASKS` PASS; C19 did not recur. Outer retry `0`.
- Result: C19 eliminated in live replay; C22 is locally corrected, while a fresh replay is required to prove the delimiter guard in the live producer.
- Workflow progress: C reached the same execute operation with canonical schema labels and passed the preceding five workflow operations.
- Live model calls consumed: 6 in this fresh C replay; the live-call ledger records operations 01 through 06.

### C23 — Execute runner did not apply the canonical output gate on slice-02

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 08, `EXECUTE_SLICE`
- Slice: `slice-02`
- Symptom: After the C22 correction, a fresh replay passed `EXECUTE_SLICE` and `VALIDATE_SLICE` for `slice-01`, then the `slice-02` runner response was classified as malformed because it used a non-canonical schema, abbreviated `SPEC_PATH` with `...`, and omitted complete file-backed `Tested state` hashes.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c23-case-c-execute-slice-02-runner-output-gate.json`; operation evidence is preserved at `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-FnhhCD/case-c/operations/08-execute_slice.json`. Official authority was `sha256:74fc647690dd024e86b861dc32e171fd2c22ee761fbf50167968758e8c3cd7f8`; outer retry remained `0`.
- Root cause: The runner contract contained the canonical schema and individual path/digest rules, but did not make the final response a high-salience byte-for-byte output gate. The live producer therefore emitted a summary-like malformed result on a later slice. The strict executor correctly persisted a delegation blocker and did not repair or publish the result.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, both execute launcher prompts, and their contract coverage.
- Correction: Added one equivalent canonical output gate to both runner adapters and both execute launchers. It requires exact schema labels/order, no translated aliases or abbreviated paths, complete task-relative tuples and full `sha256:` digests, and a complete schema even when the status is `BLOCKED`. Parser rejection and all authority checks remain strict.
- Regression added: `scripts/test-validation-runner-contract.mjs` now rejects removal of the runner output gate as `R026_OUTPUT_GATE`; `scripts/test-launcher-contract.mjs` rejects removal of the caller-side gate as `L038_EXECUTE_OUTPUT_GATE`.
- Local checks: C23 causal mutation failed when the gate was removed and passed after correction; validation-runner contracts passed 104 tests, launcher contracts passed 106 tests, repository contract check passed, and `git diff --check` passed.
- Live replay: Fresh C advanced through operation 07 (`VALIDATE_SLICE slice-01 PASS`) and stopped at operation 08; same-operation recovery is legal for `EXECUTE_SLICE slice-02`.
- Result: C22 delimiter failure did not recur and slice-01 passed the new gate live; slice-02 exposed the narrower C24 tuple-delimiter defect before publication. C24's delimiter defect was not present in the next replay, but C23's general schema recurrence became C26 after the blocker was persisted cleanly.
- Workflow progress: C advanced one operation beyond the previous C22 blocker and proved both execution and formal validation for slice-01.
- Live model calls consumed: 8 in this replay through operation 08; the live-call ledger records the calls.

### C24 — Execute runner omitted the parser's pipe-delimited tuple grammar

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 08, `EXECUTE_SLICE`
- Slice: `slice-02`
- Symptom: The runner response remained malformed after C23's canonical output gate because `Tested state` and `Commands` tuples lacked the exact delimiters required by the execution-record parser. No auxiliary check or live execution artifact was published.
- Official state: `EXECUTION_STARTED`; the controlled replay wrapper classified the missing post-operation transition as `OFFICIAL_TRANSITION_NOT_OBSERVED`.
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c24-case-c-execute-slice-02-runner-tuple-delimiters.json` and `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-6mLYuX/case-c/operations/08-execute_slice.json`. The runner's final message explicitly names malformed `Tested state`/`Commands` tuples; outer retry was `0`.
- Root cause: The C23 gate required complete values but did not state the exact serialized tuple forms consumed by the runtime: `- \`<task-relative path>\` | sha256:<64 lowercase hex>`/`REMOVED` and `- \`<full command>\` | exit:<integer>`. The producer emitted tuple-like prose without those delimiters. The strict parser and caller correctly did not repair or accept it.
- Files/components responsible: `agents/codex/.codex/agents/stnl_validation_runner.toml`, `agents/claude-code/.claude/agents/stnl-validation-runner.md`, both execute launchers, the generic executor skill, and their contract coverage.
- Correction: Added the exact pipe-delimited grammar to both runner adapters, both execute launchers, and the generic executor skill: `- \`<task-relative path>\` | sha256:<64 lowercase hex>`/`REMOVED` for `Tested state`, and `- \`<full command>\` | exit:<integer>` for `Commands`; colon/em-dash/prose substitutes remain malformed and blocked.
- Regression added: `scripts/test-validation-runner-contract.mjs` now rejects removal of the runner tuple grammar as `R027_TUPLE_GRAMMAR`; `scripts/test-launcher-contract.mjs` rejects removal of the caller grammar as `L039_EXECUTE_TUPLE_GRAMMAR`.
- Local checks: C24 causal mutations failed when the exact tuple grammar was removed and passed after correction; validation-runner contracts passed 105 tests, launcher contracts passed 107 tests, repository contract check passed, and `git diff --check` passed.
- Live replay: C passed operations 01–07, then stopped at operation 08; the prior C23 gate was exercised and did not permit malformed output to pass.
- Result: The tuple-delimiter defect did not recur in the next replay; candidate validation and readback passed while a distinct C26 schema recurrence was persisted. No authority relaxation or false PASS.
- Workflow progress: C23's general gate advanced the replay from the prior operation-06 blocker through slice-01 execution and validation to operation 08.
- Live model calls consumed: 9 including the recovery `REPLAN`; the live-call ledger records them.

### C25 — Fresh C REVIEW_PLAN producer used an invalid SPEC_PATH

- Category: `OTHER`
- Case: C
- Operation: 03, `REVIEW_PLAN`
- Slice: none
- Symptom: A fresh C replay stopped before task materialization because the REVIEW_PLAN producer's candidate validation received an invalid `SPEC_PATH`; no reviewed plan was published.
- Official state: `PLANNED_DRAFT`; official recovery `REPLAN` remained legal and returned `PLANNED_DRAFT` revision `1`.
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c25-case-c-review-plan-invalid-spec-path.json` and the preserved operation evidence at `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-oScsyB/case-c/operations/03-review_plan.json`. The harness used `GPT-5.6-Luna`/`xhigh`; outer retry remained `0`; no source mutation occurred.
- Root cause: The evidence proves a producer handoff/publication failure but does not implicate a repository component or justify weakening `SPEC_PATH` validation.
- Files/components responsible: No repository file proven responsible; live REVIEW_PLAN producer turn only.
- Correction: None. Run one fresh C workspace retry to reach the C24 proof point; if the same operation and same invalid-path cause recur, apply stop-loss.
- Regression added: Not applicable; no deterministic source defect established.
- Local checks: No source change.
- Live replay: This fresh C attempt passed `SPEC_INIT` and `PLAN`, stopped at `REVIEW_PLAN`, then performed the official `REPLAN` recovery; no execute/validation calls occurred.
- Result: C25 is a distinct producer nondeterminism and does not count as a C24 replay result.
- Workflow progress: The attempt did not reach C24; the preceding C replay had advanced through operation 07.
- Live model calls consumed: 4 (`SPEC_INIT`, `PLAN`, `REVIEW_PLAN`, `REPLAN`); all used production-v2 dispatch.

### C26 — Execute runner schema gate recurred on slice-02

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 08, `EXECUTE_SLICE`
- Slice: `slice-02`
- Symptom: With C23's output gate and C24's tuple grammar present, the runner again returned malformed output using translated labels, a different field order, and omitted required literal schema fields. Unlike the prior attempt, candidate validation passed and the delegation blocker was persisted/read back successfully.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c26-case-c-execute-slice-02-runner-schema-recurrence.json` and the preserved task artifact at `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-sHeZMd/case-c/operations/08-execute_slice/task-slice-02.md`. Outer retry remained `0`; candidate validation exited `0`.
- Root cause: The producer still treated the schema as prose guidance on a later slice instead of copying the literal requested sequence. The strict runtime correctly preserved the malformed-output singleton and did not accept a check.
- Files/components responsible: Both runner adapters and both execute launcher prompts; no runtime/parser defect is proven.
- Correction: Added the literal canonical field sequences to both runner adapters and both execute launcher prompts. The gate now requires the response to start at `Operation`, preserve the exact English order for the requested operation, and forbid preamble, translation, reorder, omission, or postamble. This is the final bounded correction for the same producer-schema family before stop-loss.
- Regression added: `scripts/test-validation-runner-contract.mjs` now rejects removal of the literal field-sequence gate as `R028_FIELD_SEQUENCE`; `scripts/test-launcher-contract.mjs` rejects removal of the caller gate as `L040_EXECUTE_FIELD_SEQUENCE`.
- Local checks: C26 causal mutations failed when the field-sequence gate was removed and passed after correction; validation-runner contracts passed 106 tests, launcher contracts passed 108 tests, repository contract check passed, and `git diff --check` passed.
- Live replay: Fresh C passed operations 01–07 and stopped at operation 08; C24 tuple grammar was not the reported cause.
- Result: Objective progress: official blocker persistence/readback now works; functional convergence remains blocked at the same producer-schema family.
- Workflow progress: C reached the same operation with a clean `RUNNER_RESULT_BLOCKED` state rather than an unobserved transition.
- Live model calls consumed: 8 in this replay; all used production-v2 dispatch.

### C27 — Execute runner serialized Tested scope as nested structure

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 10, `EXECUTE_SLICE`
- Slice: `slice-03`
- Symptom: After slice-01 and slice-02 execution/validation PASS, the slice-03 runner returned `Tested scope` as a nested bullet list instead of one scalar inline field; no implementation check was allocated.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c27-case-c-execute-slice-03-tested-scope-shape.json` and the preserved task artifact at `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-0tQOOb/case-c/operations/10-execute_slice/task-slice-03.md`. Candidate validation/readback passed; outer retry remained `0`.
- Root cause: The producer violated the execution-record shape rule: scalar summary fields are inline, while only `Tested state` and `Commands` may contain nested list items. The parser correctly rejected the nested `Tested scope` instead of accepting an alias.
- Files/components responsible: Both runner adapters, both execute launcher prompts, the generic executor skill, and their contract coverage.
- Correction: Added a strict scalar-field shape guard to both runner adapters, both execute launcher prompts, and the generic executor skill. `Tested scope`, `HEAD`, discovery/check summaries, failures, blockers, and formal-validation scalar fields must be inline; only `Tested state` and `Commands` may use the exact nested tuple lines. The repository checker was extended with `R029_FIELD_SHAPE` and `L041_EXECUTE_FIELD_SHAPE`; its existing `R026_OUTPUT_GATE` adjacency was made compatible with the new guard without weakening the response gate.
- Regression added: Added deterministic contract mutations that remove the runner scalar-field guard and the execute-caller scalar-field guard; each now fails under its dedicated category.
- Local checks: `node --test scripts/test-validation-runner-contract.mjs` (109 PASS); `node --test scripts/test-launcher-contract.mjs` (109 PASS); `node scripts/check-contracts.mjs repository --root .` (PASS); `git diff --check` (PASS).
- Live replay: C reached operation 10 after slice-02 formal validation PASS; no slice-03 validation or later operation started.
- Result: Distinct producer schema-shape blocker preserved without false PASS.
- Workflow progress: C advanced through formal validation of slice-02; only the final integration slice remains after this blocker.
- Live model calls consumed: 10 in this replay; all used production-v2 dispatch.

### C28 — Materializer replayed an invalid detailed-plan path claim

- Category: `PATH_BASIS`
- Case: C
- Operation: 4, `MATERIALIZE_TASKS`; recovery operation 5, `REPLAN`
- Slice: planning stage, expected `slice-01`
- Symptom: In the fresh C27 replay, candidate validation rejected `../../../src/validation.mjs` because it resolved to `specs/src/validation.mjs`; materialization published no tasks. The authorized replan reached `PLANNED_DRAFT`, and the replay stopped before execution.
- Official state: `PLANNED_READY` at the materializer blocker; `PLANNED_DRAFT` after recovery.
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c28-case-c-materialize-invalid-plan-path.json`, plus operation evidence under `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-b4kV8I/`, `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-u4Wplu/`, and `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-3LUD8j/`.
- Root cause: The live producer emitted a detailed-plan path claim whose relative basis did not resolve to the physical target. The candidate validator correctly failed closed; existing planner/reviewer guards were not weakened or bypassed.
- Files/components responsible: Live planning/materialization producer output; official candidate path validator rejected the claim. No repository runtime defect was established in this replay.
- Correction: No source correction. The materializer prompt and skill already require mechanical rebasing from the declaring plan artifact to the task artifact, and the runtime candidate validator rejects the invalid claim without publication. Two consecutive fresh replays after the intervening C29 replay reproduced the same materializer path-basis blocker, so the mandatory stop-loss applies.
- Regression added: Existing C17 planner/reviewer physical-identity regressions cover this path-basis invariant; no duplicate regression added.
- Local checks: No source changed for C28; C27 focused checks remained green (`109` validation-runner tests, `109` launcher tests, repository contracts, and `git diff --check`).
- Live replay: `b4kV8I`, `u4Wplu`, and `3LUD8j` each consumed 5 calls with outer retry `0`; `u4Wplu` and `3LUD8j` were consecutive final replays ending at the same materializer/replan point for the same invalid path-basis cause.
- Result: Candidate validation and authority integrity held, but no objective progress occurred in the two consecutive final replays; stop-loss `BLOCKED_NO_OBJECTIVE_PROGRESS` applies.
- Workflow progress: The last successful C checkpoint remains the C26 replay through slice-02 validation and the first slice-03 execute attempt; C28 recovery did not publish tasks in the final two replays.
- Live model calls consumed: 15 across the three C28 occurrences; production-v2 dispatch was respected.

### C29 — Execute runner emitted a 63-hex digest

- Category: `PRODUCER_CONTRACT`
- Case: C
- Operation: 6, `EXECUTE_SLICE`
- Slice: `slice-01`
- Symptom: The runner returned `sha256:` followed by 63 lowercase hexadecimal characters for a file-backed `Tested state` entry. The caller classified the result as `RUNNER_RESULT_BLOCKED`; no implementation check or retry was fabricated.
- Official state: `RUNNER_RESULT_BLOCKED`
- Evidence: `maintenance/p0-evidence/s3-autonomous-convergence-a98754-artifacts/c29-case-c-execute-slice-01-truncated-digest.json` and the preserved task artifact under `/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/sentinel-convergence-c-hiSDBU/`.
- Root cause: The live runner produced a truncated digest token. The existing strict digest guards and candidate parser correctly rejected it; no repository authority defect was established.
- Files/components responsible: Live runner output; execute caller and runtime remained strict.
- Correction: No source correction. The strict digest guards already match the runtime contract and correctly rejected the malformed output. A later fresh replay did not reach this operation because materialization hit C28; no further live call was authorized after C28 stop-loss.
- Regression added: Existing C11/C22 exact digest-format and delimiter regressions already cover this invariant; no duplicate test added.
- Local checks: No source changed for C29; C27 focused checks remained green.
- Live replay: Fresh C replay `hiSDBU` consumed 6 calls, outer retry `0`, and stopped at `EXECUTE_SLICE slice-01`; later C replays were blocked earlier by C28.
- Result: Strict authority held; no source correction was justified.
- Workflow progress: C reached materialized tasks and the first execute operation, but did not reach validation.
- Live model calls consumed: 6 in this replay; production-v2 dispatch was respected.

## Change ledger

| File | Issue(s) | Why necessary | Validation |
|---|---|---|---|
| `skills/workflows/stnl-execution-planner/runtime/execution-state.mjs` | C01 | Keep the distributed execution runtime byte-identical with the overlap ownership correction. | Byte-identical bundle check; execution contract PASS. |
| `skills/workflows/stnl-plan-reviewer/runtime/execution-state.mjs` | C01 | Keep the distributed execution runtime byte-identical with the overlap ownership correction. | Byte-identical bundle check; execution contract PASS. |
| `skills/workflows/stnl-slice-executor/runtime/execution-state.mjs` | C01 | Apply the same official candidate-evidence ownership runtime used by the executor. | Byte-identical bundle check; rehearsal PASS. |
| `skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs` | C01 | Distinguish historical path structure from current physical evidence hash ownership. | Causal regression PASS; execution contract PASS. |
| `skills/workflows/stnl-spec-roadmap/runtime/execution-state.mjs` | C01 | Keep the distributed execution runtime byte-identical. | Byte-identical bundle check. |
| `skills/workflows/stnl-spec-test-runbook/runtime/execution-state.mjs` | C01 | Keep the distributed execution runtime byte-identical. | Byte-identical bundle check. |
| `skills/workflows/stnl-task-materializer/runtime/execution-state.mjs` | C01 | Keep the distributed execution runtime byte-identical. | Byte-identical bundle check. |
| `skills/workflows/stnl-task-reviewer/runtime/execution-state.mjs` | C01 | Keep the distributed execution runtime byte-identical. | Byte-identical bundle check. |
| `scripts/test-execution-contract.mjs` | C01 | Reproduce historical overlap and protect strict current hash validation. | Focused regression PASS; 99 execution contract tests PASS. |
| `templates/prompts/slice-validate-codex.md` | C03,C04 | Require canonical authority identity and the complete official preflight command in formal validation output. | Launcher contract PASS; final local validation PASS. |
| `templates/prompts/slice-validate-claude.md` | C03,C04 | Keep the Claude formal-validation producer on the same authority and command-evidence rules. | Launcher contract PASS; final local validation PASS. |
| `templates/prompts/execution-plan.md` | C17 | Require planner-side mechanical physical-target recomputation for every plan claim. | L035 causal regression; launcher contract PASS. |
| `templates/prompts/execution-plan-review.md` | C17 | Require reviewer-side mechanical physical-target recomputation before approval. | L036 causal regression; launcher contract PASS. |
| `templates/prompts/execution-tasks.md` | C12 | Require canonical task-index headers and mechanical plan-to-task path rebasing before materialization. | L032 causal regression; final execution contract PASS. |
| `skills/workflows/stnl-execution-planner/SKILL.md` | C17 | Keep planner path claims tied to their declaring artifact and physical target. | Planner contract and final repository checks PASS. |
| `skills/workflows/stnl-plan-reviewer/SKILL.md` | C17 | Keep reviewer approval fail-closed on a plan claim that resolves to another physical path. | Reviewer contract and final repository checks PASS. |
| `skills/workflows/stnl-task-materializer/SKILL.md` | C12 | Preserve the task-index header authority and task-relative mechanical rebase rules. | Final execution contract and repository checks PASS. |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | C05,C06,C08,C09,C11,C15,C18,C19,C22,C23,C24,C26 | Align Codex runner handoff paths, authority, canonical schema, preflight, digest, tuple, output, and field-sequence contracts with runtime authority. | Causal runner mutations and final 109 validation-runner tests PASS. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | C05,C06,C08,C09,C11,C15,C18,C19,C22,C23,C24,C26 | Keep the Claude runner adapter equivalent across all strict handoff and output invariants. | Causal runner mutations and final 109 validation-runner tests PASS. |
| `templates/prompts/slice-execute-codex.md` | C05,C06,C08,C09,C11,C13,C14,C23,C24,C26 | Enforce canonical handoff paths, authority disposition, digest/tuple grammar, complete output, and literal field ordering at the execute caller. | Final launcher contract PASS. |
| `templates/prompts/slice-execute-claude.md` | C05,C06,C08,C09,C11,C13,C14,C23,C24,C26 | Keep the Claude execute caller equivalent to the Codex strict output contract. | Final launcher contract PASS. |
| `skills/workflows/stnl-slice-executor/SKILL.md` | C05,C06,C08,C09,C11,C13,C14,C22,C24 | Preserve executor-side path identity, authority, digest, tuple, and runner-output constraints. | Final repository contract and execution tests PASS. |
| `scripts/check-contracts.mjs` | C03,C04,C05,C06,C08,C09,C11,C12,C13,C14,C15,C17,C18,C19,C22,C23,C24,C26 | Encode every confirmed producer/launcher invariant as a fail-closed semantic contract category. | Repository, launcher, and subagent checks PASS. |
| `scripts/test-validation-runner-contract.mjs` | C11,C15,C18,C19,C22,C23,C24,C26 | Regress malformed digest, exact command, preflight, schema-label, delimiter, output-gate, tuple, and field-sequence failures. | Final 109 tests PASS. |
| `scripts/test-launcher-contract.mjs` | C05,C06,C09,C11,C12,C13,C14,C17,C22,C23,C24,C26 | Regress caller-side path, task-header, digest, authority, planner, tuple, output, and field-sequence guard removal. | Final 109 tests PASS. |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | C19 | Make runner output field labels match the canonical execution-record schema consumed by the runtime. | C19 schema regression and validation-runner contract PASS. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | C19 | Keep the Claude runner adapter equivalent to the canonical schema and strict malformed-output boundary. | C19 schema regression and validation-runner contract PASS. |
| `scripts/check-contracts.mjs` | C19 | Validate canonical English runner schemas and preserve strict authority/command/path/digest guards. | Repository and validation-runner contract checks PASS. |
| `scripts/test-validation-runner-contract.mjs` | C19 | Regress the translated-label/runtime-schema mismatch and update canonical contract mutations. | 102 tests PASS; causal regression failed before fix. |
| `scripts/test-execution-contract.mjs` | C19 | Ensure canonical runner labels still round-trip into persisted execution records and formal attempts. | Focused round-trip tests PASS. |
| `templates/prompts/slice-validate-codex.md` | C19 | Tell formal validation producers to write the canonical `Commands` field. | Launcher contract PASS. |
| `templates/prompts/slice-validate-claude.md` | C19 | Keep the Claude formal-validation launcher on the canonical `Commands` field. | Launcher contract PASS. |
| `benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs` | C19 | Keep deterministic R03 mutation coverage aligned with the canonical `Tested state` field. | Deterministic rehearsal PASS. |
| `templates/prompts/slice-execute-codex.md` | C22 | Make the execute caller reject `sha256=` and other non-canonical digest delimiters explicitly. | Launcher delimiter regression PASS. |
| `templates/prompts/slice-execute-claude.md` | C22 | Keep the Claude execute caller on the literal `sha256:` digest grammar. | Repository/launcher contract PASS. |
| `skills/workflows/stnl-slice-executor/SKILL.md` | C22 | Preserve the same delimiter invariant in the executor authority. | Repository contract PASS. |
| `scripts/test-launcher-contract.mjs` | C22 | Regress removal of the caller-side delimiter guard. | 105 launcher tests PASS; causal mutation covered. |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | C23 | Make the runner return exactly the canonical schema, complete paths/digests, and a complete `BLOCKED` record instead of a prose summary. | R026 causal regression; validation-runner contract PASS. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | C23 | Keep the Claude adapter byte-equivalent to the canonical runner output gate. | R026 causal regression; repository contract PASS. |
| `templates/prompts/slice-execute-codex.md` | C23 | Require the execute caller to demand and reject abbreviated runner responses. | L038 causal regression; launcher contract PASS. |
| `templates/prompts/slice-execute-claude.md` | C23 | Keep the Claude execute caller on the same strict output gate. | L038 causal regression; repository contract PASS. |
| `scripts/check-contracts.mjs` | C23 | Enforce the runner and execute-launcher output gates. | Repository contract PASS. |
| `scripts/test-validation-runner-contract.mjs` | C23 | Regress removal of the runner byte-for-byte response gate. | 104 validation-runner tests PASS. |
| `scripts/test-launcher-contract.mjs` | C23 | Regress removal of the caller-side canonical response gate. | 106 launcher tests PASS. |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | C24 | State the exact pipe-delimited `Tested state` and `Commands` serialization consumed by the runtime parser. | R027 causal regression; validation-runner contract PASS. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | C24 | Keep the Claude runner adapter's tuple grammar identical to the canonical contract. | R027 causal regression; repository contract PASS. |
| `templates/prompts/slice-execute-codex.md` | C24 | Require the execute caller to reject tuple-like prose and missing delimiters. | L039 causal regression; launcher contract PASS. |
| `templates/prompts/slice-execute-claude.md` | C24 | Keep the Claude execute caller on the exact tuple grammar. | L039 causal regression; repository contract PASS. |
| `skills/workflows/stnl-slice-executor/SKILL.md` | C24 | Preserve the parser's tuple grammar in the generic executor authority. | Repository contract PASS. |
| `scripts/check-contracts.mjs` | C24 | Enforce the runner and execute-launcher tuple grammar guards. | Repository contract PASS. |
| `scripts/test-validation-runner-contract.mjs` | C24 | Regress removal of the runner tuple grammar. | 105 validation-runner tests PASS. |
| `scripts/test-launcher-contract.mjs` | C24 | Regress removal of the execute caller tuple grammar. | 107 launcher tests PASS. |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | C26 | Require the runner's final response to copy the literal field sequence with no translation/reorder/omission. | R028 causal regression; validation-runner contract PASS. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | C26 | Keep the Claude adapter on the same literal field sequence. | R028 causal regression; repository contract PASS. |
| `templates/prompts/slice-execute-codex.md` | C26 | Require the execute caller to demand immediate canonical field order from the runner. | L040 causal regression; launcher contract PASS. |
| `templates/prompts/slice-execute-claude.md` | C26 | Keep the Claude execute caller on the same field-sequence gate. | L040 causal regression; repository contract PASS. |
| `scripts/check-contracts.mjs` | C26 | Enforce the runner and execute-launcher literal field-sequence gates. | Repository contract PASS. |
| `scripts/test-validation-runner-contract.mjs` | C26 | Regress removal of the runner field sequence. | 106 validation-runner tests PASS. |
| `scripts/test-launcher-contract.mjs` | C26 | Regress removal of the execute caller field sequence. | 108 launcher tests PASS. |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | C27 | Require scalar inline serialization for every runner field except the two exact tuple fields. | Validation-runner contract PASS. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | C27 | Keep the Claude runner adapter equivalent and fail closed on nested scalar fields. | Validation-runner contract PASS. |
| `templates/prompts/slice-execute-codex.md` | C27 | Make the execute caller require scalar inline fields before accepting runner output. | Launcher contract PASS. |
| `templates/prompts/slice-execute-claude.md` | C27 | Keep the Claude execute caller's field-shape guard equivalent. | Launcher contract PASS. |
| `skills/workflows/stnl-slice-executor/SKILL.md` | C27 | Keep the generic executor authority explicit about scalar versus tuple field shapes. | Repository contract PASS. |
| `scripts/check-contracts.mjs` | C27 | Add `R029_FIELD_SHAPE`/`L041_EXECUTE_FIELD_SHAPE` and preserve the canonical output-gate check with the new guard present. | Repository contract PASS. |
| `scripts/test-validation-runner-contract.mjs` | C27 | Regress removal of the runner field-shape guard. | 109 validation-runner tests PASS. |
| `scripts/test-launcher-contract.mjs` | C27 | Regress removal of the execute caller field-shape guard. | 109 launcher tests PASS. |

## Live model call ledger

Sequences below are unique live calls reconstructed from every preserved replay operation artifact; ranges group one replay and are not additive with the per-issue summaries. The last sequence is `218`.

| Sequence | Case | Operation | Model | Effort | Purpose | Outcome |
|---:|---|---|---|---|---|---|
| 1 | A | `SPEC_INIT` | GPT-5.6-Sol | high | Initial setup-only replay before the convergence glue correction. | PASS |
| 2–12 | A | `SPEC_INIT` → `SPEC_CLOSE` | Sol ×2; Terra ×2; Luna ×7 | high | C01 corrected functional Case A replay. | PASS; COMPLETE |
| 13–16 | C | `SPEC_INIT` → `MATERIALIZE_TASKS` | Sol ×2; Terra ×1; Luna ×1 | high/xhigh | C02 path-basis diagnosis. | BLOCKED at materialization |
| 17–25 | B | `SPEC_INIT` → `VALIDATE_SLICE slice-02` | Terra ×3; Luna ×6 | high/xhigh | Earlier B convergence replay. | BLOCKED at formal validation |
| 26–34 | C | `SPEC_INIT` → `VALIDATE_SLICE slice-02` | Sol ×2; Terra ×1; Luna ×6 | high/xhigh | C04 formal-validation authority replay. | BLOCKED at validation |
| 35–47 | B | `SPEC_INIT` → `SPEC_CLOSE` | Terra ×4; Luna ×9 | high/xhigh | B terminal replay used as integration evidence. | PASS; COMPLETE |
| 48–53 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×3 | high/xhigh | C05 auxiliary handoff diagnosis. | BLOCKED at execute |
| 54–63 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-03` | Sol ×2; Terra ×1; Luna ×7 | high/xhigh | C06 Tested-state path-basis diagnosis. | BLOCKED at execute |
| 64–76 | C | `SPEC_INIT` → `SPEC_CLOSE` | Sol ×3; Terra ×1; Luna ×9 | high/xhigh | C07 terminal-close replay. | BLOCKED at close |
| 77–82 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×3 | high/xhigh | C08 raw-authority diagnosis. | BLOCKED at execute |
| 83–88 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×3 | high/xhigh | C09 task-artifact identity diagnosis. | BLOCKED at execute |
| 89 | C | `SPEC_INIT` | Sol | high | C10 unresolved SPEC question diagnosis. | BLOCKED at SPEC_INIT |
| 90–98 | C | `SPEC_INIT` → `VALIDATE_SLICE slice-02` | Sol ×2; Terra ×1; Luna ×6 | high/xhigh | C11 formal manifest digest diagnosis. | BLOCKED at validation |
| 99–103 | C | `SPEC_INIT` → `REPLAN` | Sol ×3; Terra ×1; Luna ×1 | high/xhigh | C12 task-index header diagnosis and recovery. | BLOCKED after replan |
| 104–109 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×3 | high/xhigh | C13 execute digest diagnosis. | BLOCKED at execute |
| 110–115 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×3 | high/xhigh | C14 raw-authority disposition diagnosis. | BLOCKED at execute |
| 116–124 | C | `SPEC_INIT` → `VALIDATE_SLICE slice-02` | Sol ×2; Terra ×1; Luna ×6 | high/xhigh | C15 exact SPEC_PATH diagnosis. | BLOCKED at validation |
| 125–126 | C | `SPEC_INIT` → `PLAN` | Sol ×2 | high | C16 producer nondeterminism diagnosis. | BLOCKED at plan |
| 127–131 | C | `SPEC_INIT` → `REPLAN` | Sol ×3; Terra ×1; Luna ×1 | high/xhigh | C17 planner-only correction replay. | BLOCKED after materializer/replan |
| 132–136 | C | `SPEC_INIT` → `REPLAN` | Sol ×3; Terra ×1; Luna ×1 | high/xhigh | C17 reviewer correction replay. | BLOCKED after materializer/replan |
| 137–143 | C | `SPEC_INIT` → `VALIDATE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×4 | high/xhigh | C18 official preflight evidence diagnosis. | BLOCKED at validation |
| 144–149 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×3 | high/xhigh | C19 canonical schema-label diagnosis. | BLOCKED at execute |
| 150 | C | `SPEC_INIT` | Sol | high | C20 model turn did not publish SPEC. | BLOCKED at SPEC_INIT |
| 151–152 | C | `SPEC_INIT` → `PLAN` | Sol ×2 | high | C21 plan claim diagnosis. | BLOCKED at plan |
| 153–158 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×3 | high/xhigh | C22 digest delimiter diagnosis. | BLOCKED at execute |
| 159–166 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-02` | Sol ×2; Terra ×1; Luna ×5 | high/xhigh | C23 output-gate diagnosis. | BLOCKED at execute |
| 167–175 | C | `SPEC_INIT` → `REPLAN` | Sol ×3; Terra ×1; Luna ×5 | high/xhigh | C24 tuple grammar and authorized recovery. | BLOCKED after replan |
| 176–179 | C | `SPEC_INIT` → `REPLAN` | Sol ×3; Luna ×1 | high/xhigh | C25 invalid SPEC_PATH replay. | BLOCKED after replan |
| 180–187 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-02` | Sol ×2; Terra ×1; Luna ×5 | high/xhigh | C26 schema recurrence. | BLOCKED at execute |
| 188–197 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-03` | Sol ×2; Terra ×1; Luna ×7 | high/xhigh | C26 field-sequence correction replay; C27 exposed. | BLOCKED at slice-03 execute |
| 198–202 | C | `SPEC_INIT` → `REPLAN` | Sol ×3; Terra ×1; Luna ×1 | high/xhigh | C27 scalar-field correction replay; C28 exposed. | BLOCKED after materializer/replan |
| 203–208 | C | `SPEC_INIT` → `EXECUTE_SLICE slice-01` | Sol ×2; Terra ×1; Luna ×3 | high/xhigh | C29 truncated-digest replay. | BLOCKED at execute |
| 209–213 | C | `SPEC_INIT` → `REPLAN` | Sol ×3; Terra ×1; Luna ×1 | high/xhigh | C28 fresh replay after C29. | BLOCKED after materializer/replan |
| 214–218 | C | `SPEC_INIT` → `REPLAN` | Sol ×3; Terra ×1; Luna ×1 | high/xhigh | C28 final replay with temporary official recovery glue. | BLOCKED after materializer/replan |

Final unique live-call total: **218** — GPT-5.6-Sol/high `70`, GPT-5.6-Terra/high `34`, GPT-5.6-Luna/high `7`, GPT-5.6-Luna/xhigh `107`.

## Audit backlog

- None recorded; the repeated C28 materializer path-basis failure is a convergence blocker, not an optional backlog item.

## Audit handoff

Final convergence stopped under the mandatory stop-loss with `BLOCKED_NO_OBJECTIVE_PROGRESS`.

- Base SHA: `a98754cf2eea8329d9af246e77fc39417d5c63af`; branch: `feature/atlas-p0`; source remained uncommitted and no push was performed.
- Final working-tree diff summary: functional/runtime, prompt, adapter, checker, regression-test, and convergence-evidence edits are present; exact file list is available from the read-only `git diff --name-only` handoff check.
- Issues: C01–C29 are recorded above; C27 is the last functional source correction. C28 was reproduced in two consecutive final live replays after an intervening distinct C29 replay.
- Last functional checkpoint: C26 correction replay reached `EXECUTE_SLICE slice-03` after slice-02 execute and formal validation PASS; C27 correction was locally green but did not obtain a fresh C PASS.
- Regression coverage: C01 runtime overlap regression plus C19/C22/C23/C24/C26/C27 producer and launcher contract regressions are recorded in the Change ledger; no known source correction lacks a causal regression.
- Local validation: focused C27 contracts, repository contract checker, and `git diff --check` PASS. The full READY_FOR_USER_COMMIT gate was not claimed because live convergence stopped before A/B/C fresh PASS.
- Live convergence: Case A had a corrected PASS replay earlier; the required post-last-edit fresh A/B/C proof was not completed. Case B had an earlier PASS replay; no post-last-edit B proof was claimed. Case C remains blocked at materialization in the two final consecutive replays.
- Live calls: `218` unique calls; full grouped ledger above; no outer retry was used.
- Known residual risk: production materialization can still emit an invalid detailed-plan/task expected-area basis despite the existing explicit mechanical-rebase authority; official candidate validation fails closed, but the workflow cannot converge reliably without resolving that producer behavior.
- Invariants for audit: strict candidate hashes and paths, immutable historical evidence, canonical authority tokens, official preflight/readback, no hidden fallback, no duplicated state machine, no fixture-only branch, and outer retry `0`.
