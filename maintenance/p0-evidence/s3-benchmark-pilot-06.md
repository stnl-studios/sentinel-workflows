# S3 Production Benchmark Pilot 06

## Status

`PRODUCTION_PILOT_06_BLOCKED_CASE_A`

The durable-finalization procedure worked: canonical `finalize` returned its
documented non-zero exit for `BLOCKED`, the output was parsed and checked, and
the raw was copied byte-for-byte before managed-session cleanup.

Case A stopped earlier than the Pilot #5 terminal-integrity boundary. The
versioned launcher template was populated with normalized `slice-01`, while the
executor's official input contract requires the unsigned decimal `1`. The
top-level turn therefore blocked in deterministic preflight before
implementation or runner dispatch. The zero-retry rule was honored; no second
EXECUTE, Case B, Case C, or reviewer was started.

## Candidate

- branch: `feature/atlas-p0`
- candidate: `a546cfe1ddad925da75af6d46e7722549208342a`
- parent: `1ad5a1b327d1bfbe3c8b2e6c6e987e649ead5f13`
- commit: `docs(benchmark): record blocked Production Pilot #5`
- Production Profile: `production-v2`
- published `origin/feature/atlas-p0`: candidate SHA confirmed
- initial tree: `d877d0dc6bfb8ec46ac6419bbd813b8c6a2d2cb9`
- initial working tree: clean, with no relevant untracked files

The parent-to-candidate diff contains only benchmark-results/P0 evidence
bookkeeping for Pilot #5 and rehearsal-v5 resulting-commit bookkeeping. No
agents, skills, runtimes, launchers, benchmark runtime, scripts, seed, Cases,
or profile changed. The candidate is therefore functionally equivalent to the
rehearsal-qualified `1ad5a1b` checkpoint.

No versioned Production Pilot driver exists. The Pilot #5 finalization defect
was therefore corrected only in this session's orchestration; no frozen
candidate file was changed.

## Preconditions

| Check | Result |
|---|---|
| branch / HEAD / parent / commit subject | PASS |
| published branch HEAD | PASS |
| clean source checkout / `git diff --check` | PASS |
| functional-equivalence gate | PASS — evidence/results/bookkeeping only |
| benchmark authority = `production-v2` | PASS |
| benchmark verify | PASS |
| seed tests | 8/8 PASS |
| benchmark contracts | 9/9 PASS |
| Environment deterministic tests | 5/5 PASS |
| Agent Harness deterministic tests | 24/24 PASS |
| execution contracts | 95/95 PASS |
| validation-runner contracts | 95/95 PASS |
| launcher contracts | 90/90 PASS |
| repository contracts | PASS |
| `validate.sh --no-smoke` | PASS |
| Environment Doctor v1 | `ENVIRONMENT_READY` |
| Agent Harness v1 | `HARNESS_COMPLETED` |
| provider / contract | Codex / 1 |
| provider version | `codex-cli 0.154.0` |
| capability fingerprint | `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441` |
| one-shot Luna/medium probe | `HARNESS_COMPLETED`; `PROBE_PASS`; zero retry |
| Environment v1 | READY |
| Agent Harness v1 qualification | READY |
| Pre-Pilot Rehearsal v5 | `PRE_PILOT_REHEARSAL_READY` |
| Pilot #1–#4 raw integrity | PASS before Case A |

No rehearsal, R01–R13, qualification, broad audit, correction, or hardening was
run.

## Finalization durability

| Case | Finalize exit | Output created? | Output status | Copied before cleanup? | Byte-identical? | Raw SHA-256 | Cleanup after persistence? |
|---|---:|---|---|---|---|---|---|
| A | 1 | yes | `BLOCKED` | yes | yes | `6c2d421fbdc0aa7341a8874fe6e29e8de4fd557dcf739cbcb3f9c537e15e92f8` | yes |
| B | not run | no | not applicable | not applicable | not applicable | not applicable | not applicable |
| C | not run | no | not applicable | not applicable | not applicable | not applicable | not applicable |

The Case A source and destination were both 2,625 bytes. Identity checks passed
for `caseId=A`, candidate SHA, `production-v2`, and `status=BLOCKED`. The
collector stdout declared `BLOCKED`; stderr contained only the documented
non-PASS finalization message.

## Case A

- session start: `2026-09-17T17:40:54.962Z`
- prepared baseline captured: `2026-09-17T17:40:55.303Z`
- first model-call start: `2026-09-17T17:41:29.542Z`
- finalization start: `2026-09-17T18:01:14.636Z`
- managed cleanup completed after persistence: `2026-09-17T18:01:57.802Z`

| Event | Operation | Slice | Model / effort | Result | Resulting state |
|---:|---|---|---|---|---|
| 1 | `SPEC_INIT` | — | Sol / high | PASS | `ready` |
| 2 | `PLAN` | — | Terra / high | PASS | `PLANNED_DRAFT` |
| 3 | `REVIEW_PLAN` | — | Luna / high | PASS | `PLANNED_READY` |
| 4 | `MATERIALIZE_TASKS` | — | Terra / high | PASS | `MATERIALIZED_PRISTINE` |
| 5 | `REVIEW_TASKS` | — | Luna / high | PASS | `MATERIALIZED_PRISTINE` |
| 6 | `EXECUTE_SLICE` | `slice-01` | Luna / high | BLOCKED | `MATERIALIZED_PRISTINE` |

The blocked EXECUTE session started and ended normally at the Harness boundary.
Its official preflight rejected the supplied slice representation before any
implementation write, child runner, or tested-state record. The journal records
one mechanical rejection and zero retry.

## Terminal integrity forensic

Target: `src/cli.mjs`. Physical identity is SHA-256 over current file bytes.
The target existed and remained 1,318 bytes at every applicable checkpoint.

| Checkpoint | Physical SHA | Recorded/Tested/Manifest SHA | State/Source |
|---|---|---|---|
| F00 | `sha256:d01942b7d13353ce01369c9d82a0a62c807b64e1ef05f3f9858d0e75506452cb` | unavailable | prepared baseline; local Git clean |
| F01 | `sha256:d01942b7d13353ce01369c9d82a0a62c807b64e1ef05f3f9858d0e75506452cb` | unavailable | immediately before slice-01 EXECUTE; `MATERIALIZED_PRISTINE` |
| F02 | `sha256:d01942b7d13353ce01369c9d82a0a62c807b64e1ef05f3f9858d0e75506452cb` | unavailable | EXECUTE preflight BLOCKED; Changed Areas unavailable; runner `NOT_STARTED`; task artifact `specs/benchmark-case-a/execution/tasks/slice-01.md` hash `sha256:8289311ca906f0c10fc0c40f10e4459d991a6293fcec2a76da5c8cf79472576c` |
| F08 | `sha256:d01942b7d13353ce01369c9d82a0a62c807b64e1ef05f3f9858d0e75506452cb` | unavailable | official read-only execution validator PASS; state `MATERIALIZED_PRISTINE`; before/after physical hashes identical; no expected implementation hash exposed |
| F09 | `sha256:d01942b7d13353ce01369c9d82a0a62c807b64e1ef05f3f9858d0e75506452cb` | unavailable | finalizer input; lifecycle `ready`; journal terminal event = blocked slice-01 EXECUTE |

F03–F07 were not applicable because no slice validation occurred. Candidate
pre-publication physical snapshot was unavailable under the frozen contract and
was not invented. No additional implementation path was implicated.

## Forensic classification

`NOT_REPRODUCED`

The Pilot #5 terminal mismatch boundary was never reached: Case A blocked before
the first implementation write and every applicable physical snapshot of
`src/cli.mjs` remained identical.

## Cases B/C

- B: `NOT_RUN — Case A canary did not PASS`
- C: `NOT_RUN — Case A canary did not PASS`

No B/C root, workspace, journal, result, TMPDIR, Git state, or model session was
created.

## Parallelism

Not applicable. Case A did not authorize B/C.

## Reviewer

`NOT_RUN — reviewer is not required after a blocked canary`

## Profile compliance

The raw reports `profileMismatches=[]`, zero Sol escalations, and the exact
production-v2 model/effort assignment for all six events. The blocked EXECUTE
started no child dispatch.

## Operational repetition

| Fact | Value |
|---|---:|
| top-level workflow events | 6 |
| PLAN reviews | 1 |
| TASK reviews | 1 |
| REPLAN | 0 |
| EXECUTE calls | 1 |
| VALIDATE calls | 0 |
| APPLY_FINDINGS calls | 0 |
| mechanical rejections | 1 |
| external Harness retries | 0 |
| same-operation re-entry | 0 |

## Context pressure

The canonical raw reports 11,174 PLAN bytes / 1,554 words and 6,693 TASKS
bytes / 894 words. Actual token telemetry, handoff bytes, and observable reads
were unavailable and were not estimated.

## Raw hashes

| Case | Raw | SHA-256 |
|---|---|---|
| A | `maintenance/benchmark-results/a546cfe1ddad925da75af6d46e7722549208342a/case-a-production-v2.json` | `6c2d421fbdc0aa7341a8874fe6e29e8de4fd557dcf739cbcb3f9c537e15e92f8` |
| B | not produced | not applicable |
| C | not produced | not applicable |

## Baseline

`OFFICIAL_E2E_BASELINE = NOT_YET_ESTABLISHED`

## Gates

Case A blocked, so the ledger remains unchanged.

| Gate | Before | After |
|---|---|---|
| G1 | PROVEN | PROVEN |
| G2 | PARTIAL | PARTIAL |
| G3 | PARTIAL | PARTIAL |
| G4 | PROVEN | PROVEN |
| G5 | PROVEN | PROVEN |
| G6 | NOT_YET_PROVEN | NOT_YET_PROVEN |

## P0

`P0_OPEN`

## Historical integrity

| Pilot | SHA-256 | Result |
|---|---|---|
| #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |
| #4 | `fa6b421fe4861a497f15f5432acfdb7f3b5d22e5e3c48780398181f6a794a202` | byte-identical |
| #5 | historical evidence preserved; raw unavailable by historical fact | unchanged |

No Pilot #5 raw was invented or reconstructed.

## Source mutation guard

PASS before raw/evidence persistence:

- HEAD remained `a546cfe1ddad925da75af6d46e7722549208342a`;
- tree remained `d877d0dc6bfb8ec46ac6419bbd813b8c6a2d2cb9`;
- working tree remained clean;
- candidate functional bytes were not modified by the Pilot.

After live execution, source-checkout changes are confined to the authorized
Pilot #6 raw and evidence/results bookkeeping.

## Residual

The next checkpoint must supply the executor launcher's `SLICE` input as the
contracted unsigned decimal (`1`), then run a new frozen-candidate Pilot. No
terminal-integrity product correction is supported by this run because that
boundary was not reached.

## Resulting commit

`6de87f5d3d8f02ee27b8826942481c0529496291`
