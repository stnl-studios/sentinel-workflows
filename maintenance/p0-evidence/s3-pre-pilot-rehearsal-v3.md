# S3 Pre-Pilot Rehearsal v3

## Status

`PRE_PILOT_REHEARSAL_BLOCKED`

## Base

`bfe0a190993d48428acaaa827b84a6db2e4124b1`

- branch: `feature/atlas-p0`
- parent: `5d9ecc9b4aa143519948f020ab771f257d0186b0`
- initial working tree: clean, with no relevant untracked files
- published branch HEAD: confirmed on `origin/feature/atlas-p0`
- Production Profile: `production-v2`
- Environment v1: `ENVIRONMENT_READY`
- Agent Harness v1: `HARNESS_COMPLETED`

## Previous blocker

`FIXTURE_PATH_BASIS`

## Path root cause

The historical POST-R06 producer was ephemeral rather than repository-owned.
Its observed path geometry proves that it derived a path from an external
candidate/session basis and then persisted that value in the live detailed task.
The normal R01–R06 fixture already derived paths from the final artifacts.

| Item | Value |
| --- | --- |
| artifact | `spec/execution/tasks/slice-01.md` |
| artifact base | `spec/execution/tasks/` |
| bad stored path | `../../../workspaces/r07-isolated/src/invitation.mjs` |
| bad resolved target | `workspace/workspaces/r07-isolated/src/invitation.mjs` (absent) |
| canonical stored path | `../../../src/invitation.mjs` |
| canonical resolved target | `workspace/src/invitation.mjs` |
| expected implementation target | `workspace/src/invitation.mjs` |
| cause | candidate/session-root-relative arithmetic was persisted as though it were detailed-task-relative |

## Correction

| Path | Semantic delta |
| --- | --- |
| `benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs` | Centralize artifact-relative derivation from the final artifact path; create a legitimate candidate-validated POST-R06 fixture; add the pre-live path gate and isolated R07 entrypoint; preserve strict runtime validation. |
| `scripts/test-benchmark-rehearsal.mjs` | Cover the valid canonical path, the exact observed invalid path, containment, existence, hash, and no auto-correction. |
| `maintenance/p0-evidence/s3-pre-pilot-rehearsal-v2.md` | Replace only the pending resulting commit with the published v2 SHA. |
| `maintenance/p0-evidence/checkpoints.md` | Freeze the v2 checkpoint at its published SHA and append the factual v3 checkpoint. |
| `maintenance/p0-evidence/README.md` | Add the v3 evidence entry without removing history. |
| `maintenance/p0-evidence/s3-pre-pilot-rehearsal-v3.md` | Record this rehearsal outcome. |

No validation-runner, execution runtime, lifecycle runtime, authority algorithm,
Production Profile, Case, seed, budgets, journal/result schema, Agent Harness
core, or Environment contract changed.

## Path regression

| Case | Basis/result |
| --- | --- |
| valid canonical path | five known fixture claims resolve exactly to `workspace/src/invitation.mjs` |
| observed invalid path | rejected pre-live as `FIXTURE_PATH_BASIS`; it remains unchanged by the gate |
| containment | canonical claims remain inside the workspace and outside SPEC; an explicit escape is rejected |
| existence/hash | target exists and the implementation tested-state SHA-256 matches current bytes |
| result | 3 focused path tests PASS; full rehearsal contract suite 6/6 PASS |

## Isolated R07

- pre-state: `IMPLEMENTED_AWAITING_VALIDATION`
- pre-live path gate: `FIXTURE_PATH_BASIS_PASS`, 5/5 rows PASS
- runner result: `PASS`; exact commands; one valid `attempt-01`
- candidate publication: accepted with a valid Effective Validation Base
- final state: `COMPLETE`
- live calls: exactly one; zero external retry

## Full rehearsal

| Stage | Result | Evidence |
| --- | --- | --- |
| R01 | PASS | canonical authority differs from raw requirements SHA; current and non-stale |
| R02 | PASS | real authority mutation produced `REQUIREMENTS_CHANGED` and `REPLAN` recovery |
| R03 | PASS | runner v8 accepted; R019 raw authority and R020 abbreviated commands rejected |
| R04 | PASS | one BLOCKED operation/check; `AUXILIARY_BLOCKED`; terminal; zero re-entry |
| R05 | PASS | fresh fixture `MATERIALIZED_PRISTINE`; canonical path gate PASS |
| R06 | PASS | Harness completed; one `TESTS_PASS`; `IMPLEMENTED_AWAITING_VALIDATION` |
| R07 | PASS | pre-live path gate PASS; formal PASS; valid base; `COMPLETE` |
| R08 | PASS | terminal readback current; paths/hashes owned; no blocker/divergence/finding |
| R09 | PASS | GLOBAL READY; execution byte-identical; canonical attestation created |
| R10 | PASS | lifecycle CLOSED; execution byte-identical and still `COMPLETE` |
| R11 | FAIL | `HARNESS_INIT_FAILED` before reviewer session start; no semantic verdict |
| R12 | NOT_RUN | prohibited after R11 failure |
| R13 | NOT_RUN | prohibited after R11 failure |

## Live calls

| Stage | Purpose | Model | Effort | Harness | Semantic result | Retry |
| --- | --- | --- | --- | --- | --- | ---: |
| isolated R07 | prove corrected POST-R06 fixture | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | runner PASS; publication accepted; `COMPLETE` | 0 |
| R06 | live EXECUTE_SLICE | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | `TESTS_PASS`; `IMPLEMENTED_AWAITING_VALIDATION` | 0 |
| R07 | live VALIDATE_SLICE | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | formal PASS; `COMPLETE` | 0 |
| R09 | GLOBAL READINESS | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | READY; execution preserved | 0 |
| R10 | SPEC CLOSE | GPT-5.6-Sol | high | `HARNESS_COMPLETED` | CLOSED; execution preserved | 0 |
| R11 | independent reviewer | GPT-5.6-Sol | high | `HARNESS_INIT_FAILED` | no session; no verdict | 0 |

Both R07 validation children used GPT-5.6-Luna / medium. No live operation was
retried externally.

## Reviewer

`BLOCKING_FINDING`

The required reviewer session did not start. This repeats the historical
pre-session reviewer initialization failure from Production Pilot #4. A fresh
read-only Harness capability check still returned `HARNESS_COMPLETED`, but that
does not substitute for the required real reviewer session.

## Parallel smoke

- B start: not run;
- C start: not run;
- overlap: not claimed;
- isolation: not evaluated;
- cleanup: all completed/failed managed sessions cleaned independently.

## Remediation cycles

Exactly one remediation cycle was used: the authorized
`FIXTURE_PATH_BASIS` correction. It passed its gate/regression, made isolated
R07 `COMPLETE`, and advanced the fresh rehearsal through R10. No Cycle 2 was
used because R11 repeated a known reviewer-initialization blocker; the stop
policy forbids correcting the same historical problem in this session.

## Historical integrity

| Pilot | SHA-256 | Result |
| --- | --- | --- |
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

`OFFICIAL_E2E_BASELINE = NOT_YET_ESTABLISHED`

## Final checks

| Command/check | Result |
| --- | --- |
| initial `benchmark verify` | PASS |
| initial Environment doctor | `ENVIRONMENT_READY` |
| initial and post-failure Agent Harness check | `HARNESS_COMPLETED` |
| `node --test scripts/test-benchmark-rehearsal.mjs` | PASS, 6/6 |
| `node scripts/test-validation-runner-contract.mjs` | PASS, 93/93 |
| deterministic R01–R05 driver | PASS |
| `git diff --check` | PASS |
| historical Pilot #1–#4 raw SHA-256 | PASS, byte-identical |
| full R13 suite | NOT_RUN; prohibited after R11 failure |

## Next

No Production Pilot is authorized. Failed stage: R11. Failure category:
`HARNESS_INIT_FAILED`. Objective blocker: the required GPT-5.6-Sol/high
read-only reviewer did not start and produced no semantic verdict. Last passing
stage: R10. Remediation cycles used: one. Objective advancement occurred from
the fixture-path failure through isolated `COMPLETE` and full R01–R10 PASS.

## Resulting commit

`pending user commit`
