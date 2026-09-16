# S3 Benchmark Correction 02

## Base

`abefcb5d7a5d1e0a3a752388f69b74fd3f299648`

- branch: `feature/atlas-p0`
- parent: `6b193cdd751d7d772d2288709169913f8e8c30e7`
- initial working tree: clean, with no untracked files
- the base-to-parent interval changed only Pilot #2 raw result and evidence;
  no functional file changed

## Trigger

Pilot #2: `S3_BENCHMARK_PILOT_02_BLOCKED`

## Proven collector defects

- A recovered historical `BLOCKED` event incorrectly terminalized the whole
  run.
- The terminal sequence omitted the required GLOBAL READINESS between
  execution `COMPLETE` and lifecycle `CLOSE`.
- The journal `resultingState` was trusted without an authoritative final
  execution-runtime inspection.

## Collector corrections

| Issue | Before | After |
| --- | --- | --- |
| recovered `BLOCKED` | terminal forever | historical after effective recovery |
| terminal order | `COMPLETE -> CLOSE` | `COMPLETE -> GLOBAL_READY -> CLOSE` |
| final state authority | journal | official execution runtime |

`ABORTED_BUDGET` remains dominant. A non-recovered effective blocker still
returns `BLOCKED`; other terminal inconsistencies return `FAIL`. For `case` and
`full`, `PASS` now requires the exact successful terminal journal tail,
`SPEC_READINESS(resultingState=GLOBAL_READY)`, official execution readback
`COMPLETE`, structurally terminal execution artifacts, official lifecycle
closure, matching requirements and Sentinel SHA facts, and final tests PASS.

## Ownership diagnosis

Classification:

`not-uniquely-attributable-with-preserved-evidence`

The exact Pilot #2 workspace was not available from a path recorded in the
preserved evidence. No filesystem or `/tmp` search was performed. The preserved
raw result and Pilot evidence do not contain the eight raw `Files:` claims,
resolved targets, expected/observed hashes, candidate/readback output, or a
mutation timeline. They cannot distinguish an incomplete/ignored mandatory
candidate/readback path from post-PASS workspace drift.

A deterministic R1-R5 reproducer reused the current execution templates and
test helpers:

| Reproducer | Expected | Observed |
| --- | --- | --- |
| R1 correct task-relative base | candidate validation `COMPLETE` | `COMPLETE` |
| R2 project-root-like/wrong task-relative basis | reject before publication | rejected; live artifacts unchanged |
| R3 correct path with wrong SHA-256 | reject before publication | rejected; ownership mismatch |
| R4 drift after published PASS | terminal inspection rejects with recovery | rejected; `REPLAN`, owner `terminal-integrity` |
| R5 unchanged published candidate | strict terminal readback `COMPLETE` | `COMPLETE` |

Layer owner: the official terminal ownership runtime is behaving as contracted.
The root cause of the historical Pilot #2 persistence cannot be assigned more
narrowly from preserved evidence. The corrected collector now prevents that
uncertainty from producing a false terminal PASS in the next Pilot.

## Functional Sentinel change

None.

`scripts/test-execution-contract.mjs` received only the focal R1-R5 regression.
No execution runtime, quality-manager contract, validation-runner contract,
lifecycle implementation, state name, operation, retry policy, publisher, or
candidate-isolation design changed.

## Preserved

- Pilot #1 and Pilot #2 historical raw results and evidence.
- G4 proof from the five Luna/medium validation runners, Luna execution and
  review/validation, zero fallback, and zero Sol escalation.
- Production Profile, budgets, Cases, seed, schemas, and benchmark hashes.
- Lifecycle `CLOSE` behavior and preservation of `execution/`.
- The recovered Pilot #2 `mkdtemp EPERM` remains benchmark-environment backlog,
  not a blocker and not part of this patch.

## Historical integrity

| Raw result | Before SHA-256 | After SHA-256 | Identity |
| --- | --- | --- | --- |
| Pilot #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| Pilot #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |

The historical Pilot #2 status remains `BLOCKED`; it was not rewritten.

## Tests

| Command | Exit | Result |
| --- | ---: | --- |
| `node benchmarks/sentinel-todo/runtime/benchmark.mjs verify` | 0 | PASS |
| `node --test benchmarks/sentinel-todo/seed/test/*.test.mjs` | 0 | 8/8 PASS |
| `node scripts/test-benchmark-contract.mjs` | 0 | 7/7 PASS, including terminal status/order/authority regressions |
| `node --test --test-name-pattern='Effective Validation Base ownership reproducer' scripts/test-execution-contract.mjs` | 0 | 1/1 PASS |
| `node --test scripts/test-execution-contract.mjs` | 0 | 93/93 PASS |
| `node scripts/check-contracts.mjs repository --root .` | 0 | PASS |
| `bash scripts/validate.sh --no-smoke` | 0 | PASS |
| `git diff --check` | 0 | PASS |

No E2E/model benchmark ran.

## Reviewer

`GPT-5.6-Sol / high`: `PASS`.

The reviewer first identified that a generic readiness PASS did not prove
GLOBAL READY. The same reviewer passed the corrected gate after `finalize`
required `resultingState=GLOBAL_READY` and regressions proved missing or wrong
readiness states return `FAIL`.

## P0 ledger

- G1 = PROVEN
- G2 = PARTIAL
- G3 = PARTIAL
- G4 = PROVEN
- G5 = PROVEN
- G6 = NOT_YET_PROVEN

This correction does not promote G2, G3, or G6.

## Status

`BENCHMARK_CORRECTION_02_READY_FOR_REPILOT`

## Resulting commit

`pending user commit`
