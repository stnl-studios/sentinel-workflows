# S3 Pre-Pilot Rehearsal v5

## Status

`PRE_PILOT_REHEARSAL_READY`

## Base

`b1fb9e182c15a2442aba09872cf11f3e6d49dd13`

- branch: `feature/atlas-p0`
- parent: `f3aea3598620a4f9d214ab3df44e0f935e058168`
- commit: `fix(benchmark): prepare git-backed rehearsal workspaces`
- published branch HEAD: confirmed on `origin/feature/atlas-p0`
- initial working tree: clean, with no relevant untracked files
- Production Profile: `production-v2`
- Environment v1: READY
- Agent Harness v1: READY
- capability hash: `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441`

## Initial blocker

`EXECUTION_ARTIFACT_PATH_BASIS`

The execution-record schema already defined file-backed Changed Areas,
Corrections, and Tested state as task-relative. EXECUTE producers did not
explicitly derive them from the final `tasks/slice-NN.md`, and candidate
validation did not verify current file-backed physical identity and hash before
publication.

## Correction cycles

| Cycle | Blocker | Root cause | Correction | Regression | Furthest stage |
|---:|---|---|---|---|---|
| 1 | `EXECUTION_ARTIFACT_PATH_BASIS` | Producer contracts left the task-relative derivation implicit; candidate validation accepted wrong-basis current evidence. | Make final-task derivation explicit and reject wrong basis, absence, containment escape, hash mismatch, and incomplete ownership before publication. | Execution 93/93; runner 95/95; launcher 86/86; rehearsal 9/9; isolated chain reached `COMPLETE`. | R07 in fresh full run |
| 2 | `VALIDATION_RUNNER_DELEGATION_IDENTITY` | Delegated R07 did not preserve the concrete canonical `SPEC_PATH` and registered runner identity consistently. | Require byte-identical absolute `SPEC_PATH` forwarding after official preflight; forbid shell/path substitution for runner identity. | Launcher 88/88; runner 95/95; rehearsal 9/9. | R07 runner started and returned a semantic verdict |
| 3 | `CRITICAL_FIXTURE_SEMANTIC_COVERAGE` | The fixture reused R-001/AC-001 but planned and tested only the UTC predicate, omitting the public envelope and no-participation behavior. | Align the bounded plan, public contract, implementation target, and focused tests to the full expired-invitation contract. | Rehearsal 10/10; execution 93/93; isolated chain reached `COMPLETE`. | R06 in fresh full run |
| 4 | `EXECUTION_AUTHORITY_IDENTITY` | EXECUTE could reconstruct a raw requirements hash because producer contracts named the authority but did not require exact preflight-field identity. | Copy only the official preflight `authority=sha256:<64hex>` byte-identically; forbid raw/reconstructed authority in executor and EXECUTE/APPLY launchers. | Launcher 90/90; runner 95/95; rehearsal 10/10; isolated chain reached `COMPLETE`. | R13 PASS |

## Product changes

| Path | Semantic delta |
|---|---|
| `skills/workflows/stnl-slice-executor/SKILL.md` | Define final-task path derivation and exact canonical preflight-authority identity for EXECUTE/APPLY producers. |
| `skills/workflows/stnl-slice-quality-manager/SKILL.md` | Preserve the concrete canonical `SPEC_PATH` byte-identically across validation delegation. |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | Require task-relative Tested state for every operation and exact physical target identity. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | Mirror the canonical runner Tested state path contract. |
| `templates/prompts/slice-execute-codex.md` | Require final-task path derivation and exact preflight authority forwarding. |
| `templates/prompts/slice-execute-claude.md` | Mirror EXECUTE path and authority producer requirements. |
| `templates/prompts/slice-apply-findings-codex.md` | Require final-task correction/test paths and exact preflight authority forwarding. |
| `templates/prompts/slice-apply-findings-claude.md` | Mirror APPLY path and authority producer requirements. |
| `templates/prompts/slice-validate-codex.md` | Require concrete canonical `SPEC_PATH` identity and registered runner invocation. |
| `templates/prompts/slice-validate-claude.md` | Mirror validation delegation identity requirements. |
| `skills/workflows/stnl-execution-planner/runtime/execution-state.mjs` | Reject invalid current file-backed candidate paths, hashes, and ownership before publication. |
| `skills/workflows/stnl-plan-reviewer/runtime/execution-state.mjs` | Distribute the byte-identical execution-state runtime. |
| `skills/workflows/stnl-slice-executor/runtime/execution-state.mjs` | Canonical implementation of early file-backed candidate rejection. |
| `skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs` | Distribute the byte-identical execution-state runtime. |
| `skills/workflows/stnl-spec-roadmap/runtime/execution-state.mjs` | Distribute the byte-identical execution-state runtime. |
| `skills/workflows/stnl-spec-test-runbook/runtime/execution-state.mjs` | Distribute the byte-identical execution-state runtime. |
| `skills/workflows/stnl-task-materializer/runtime/execution-state.mjs` | Distribute the byte-identical execution-state runtime. |
| `skills/workflows/stnl-task-reviewer/runtime/execution-state.mjs` | Distribute the byte-identical execution-state runtime. |
| `scripts/check-contracts.mjs` | Enforce Tested state basis, launcher path basis, delegation identity, and preflight-authority identity. |
| `scripts/test-execution-contract.mjs` | Use real file bytes/hashes in execution candidate coverage. |
| `scripts/test-validation-runner-contract.mjs` | Add negative Tested state basis/identity coverage. |
| `scripts/test-launcher-contract.mjs` | Add negative path, `SPEC_PATH`, runner identity, and canonical authority coverage. |
| `scripts/test-benchmark-rehearsal.mjs` | Cover P01-P06, semantic fixture completeness, and Git geometry/isolation. |
| `benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs` | Run live isolated R06→R07, enforce the semantic fixture, exercise new contract mutations, and record all full rehearsal stages. |
| `maintenance/p0-evidence/s3-pre-pilot-rehearsal-v4.md` | Freeze only the published v4 resulting commit. |
| `maintenance/p0-evidence/README.md` | Index v5 while preserving prior evidence. |
| `maintenance/p0-evidence/checkpoints.md` | Freeze v4 and append the pending v5 checkpoint. |
| `maintenance/p0-evidence/s3-pre-pilot-rehearsal-v5.md` | Record this convergence and final READY evidence. |

No Production Pilot, benchmark Case, budget, profile, Environment core,
Harness core, lifecycle state machine, or requirements-authority algorithm was
changed.

## Isolated validations

| Validation | Result |
|---|---|
| P01 canonical path resolves from final task artifact to physical target | PASS |
| P02 `src/invitation.mjs` wrong basis is rejected | PASS |
| P03 Changed Areas canonical task-relative path | PASS |
| P04 implementation Tested state canonical task-relative path | PASS |
| P05 hash matches the real target bytes | PASS |
| P06 wrong-basis candidate rejected before live publication | PASS |
| Final isolated R06 live EXECUTE | `HARNESS_COMPLETED`; `TESTS_PASS`; `IMPLEMENTED_AWAITING_VALIDATION` |
| Final isolated path gate | PASS |
| Final isolated R07 live VALIDATE | `HARNESS_COMPLETED`; formal PASS; `COMPLETE` |
| Final isolated retries | 0 |

## Final full rehearsal

The final full run used a fresh managed root and reused no isolated workspace.

| Stage | Result | Evidence |
|---|---|---|
| R01 | PASS | canonical authority current, non-stale, and distinct from raw file SHA |
| R02 | PASS | authority mutation produced `REQUIREMENTS_CHANGED` with `REPLAN` recovery |
| R03 | PASS | runner v8; R019/R020/R008 negative contracts rejected |
| R04 | PASS | valid BLOCKED stops after one event/check with zero re-entry |
| R05 | PASS | fresh `MATERIALIZED_PRISTINE` fixture and canonical path gate |
| R06 | PASS | Harness completed; one `TESTS_PASS`; `IMPLEMENTED_AWAITING_VALIDATION` |
| R07 | PASS | pre-live path gate; formal PASS; Effective Validation Base; `COMPLETE` |
| R08 | PASS | terminal readback; authority and final ownership intact; no active blocker |
| R09 | PASS | GLOBAL READY; execution byte-identical; canonical attestation created |
| R10 | PASS | SPEC_CLOSED; execution byte-identical; execution remains `COMPLETE` |
| R11 | PASS | independent reviewer returned PASS |
| R12 | PASS | B/C overlap, isolation, markers, and cleanup PASS |
| R13 | PASS | 12/12 required final checks PASS |

## Live calls

| Stage | Model | Effort | Harness | Semantic result | Retry |
|---|---|---|---|---|---:|
| R06 | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | `TESTS_PASS`; awaiting validation | 0 |
| R07 | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | formal PASS; `COMPLETE` | 0 |
| R09 | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | GLOBAL READY | 0 |
| R10 | GPT-5.6-Sol | high | `HARNESS_COMPLETED` | SPEC_CLOSED | 0 |
| R11 | GPT-5.6-Sol | high | `HARNESS_COMPLETED` | PASS | 0 |
| R12-B | GPT-5.6-Luna | medium | `HARNESS_COMPLETED` | `B_ONLY_71f2` | 0 |
| R12-C | GPT-5.6-Luna | medium | `HARNESS_COMPLETED` | `C_ONLY_9ac4` | 0 |

## Reviewer

`PASS`

- workspace preflight: `HARNESS_WORKSPACE_GIT_READY`
- provider invocation accepted: true
- session/turn started: true/true
- sandbox: read-only
- retry: 0
- semantic verdict: producer basis and early candidate rejection are correct;
  R01-R10 passed; no concrete Production Pilot blocker remains.

## Parallel smoke

`PASS`

- B/C Harness: `HARNESS_COMPLETED` / `HARNESS_COMPLETED`
- real interval overlap: PASS
- workspace/session/TMPDIR/Git isolation: PASS
- own markers: PASS
- cross-marker leakage: not observed
- cleanup: PASS
- retries: 0 / 0

## R13

| Check | Result |
|---|---|
| `git diff --check` | PASS |
| benchmark verify | PASS |
| seed tests | PASS |
| benchmark contracts | PASS |
| Environment deterministic tests | PASS |
| Agent Harness deterministic tests | PASS |
| execution contracts | PASS |
| validation-runner contracts | PASS |
| launcher contracts | PASS |
| repository contracts | PASS |
| rehearsal contracts | PASS |
| `validate.sh --no-smoke` | PASS |

## Stop-loss

Not activated. The session used all four permitted causal correction cycles;
the fourth produced objective advancement through R13 and READY.

## Historical integrity

| Pilot | SHA-256 | Result |
|---|---|---|
| #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |
| #4 | `fa6b421fe4861a497f15f5432acfdb7f3b5d22e5e3c48780398181f6a794a202` | byte-identical |

## P0 ledger

INALTERADO:

- G1 PROVEN
- G2 PARTIAL
- G3 PARTIAL
- G4 PROVEN
- G5 PROVEN
- G6 NOT_YET_PROVEN

## Baseline

`NOT_YET_ESTABLISHED`

## Next

Production Pilot #4 after the user publishes a new frozen SHA. The Pilot was
not executed in this session.

## Resulting commit

`1ad5a1b327d1bfbe3c8b2e6c6e987e649ead5f13`
