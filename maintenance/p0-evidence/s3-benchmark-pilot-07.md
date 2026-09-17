# S3 Production Benchmark Pilot 07

## Status

`PRODUCTION_PILOT_07_BLOCKED_CASE_A`

Case A passed documentary `SPEC_INIT`, then stopped during `PLAN`. The planner's
isolated candidate was rejected by deterministic candidate validation on
`plans/slice-02.md`: the resolved implementation path was the invalid
`plans/list`. No planning artifact was published, execution remained `EMPTY`,
and the zero-retry stop-loss was honored.

The session-level orchestration corrections both worked. Slice launchers were
rendered with unsigned-decimal input in the deterministic preflight, and the
canonical `BLOCKED` result produced by `finalize` was parsed, identity-checked,
copied byte-for-byte, and hashed before cleanup despite finalize exit `1`.

## Candidate

- branch: `feature/atlas-p0`
- candidate: `6de87f5d3d8f02ee27b8826942481c0529496291`
- parent: `a546cfe1ddad925da75af6d46e7722549208342a`
- commit: `docs(benchmark): record blocked Production Pilot #6`
- tree: `90cb1ed9db9331bd676af7056ba11ed72c355c99`
- Production Profile: `production-v2`
- published `origin/feature/atlas-p0`: candidate SHA confirmed
- initial working tree: clean, with no relevant untracked files

The qualified functional checkpoint
`1ad5a1b327d1bfbe3c8b2e6c6e987e649ead5f13` to candidate diff contains only
Pilot #5 and Pilot #6 raw/evidence/results bookkeeping plus prior
resulting-commit bookkeeping. No agent, skill, runtime, launcher, benchmark
runtime, script, seed, Case, or profile/config path changed. The candidate is
functionally equivalent to the rehearsal-qualified checkpoint.

No versioned Production Pilot driver was created. The two Pilot #7 corrections
were applied only by the external session orchestrator.

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
| execution contracts | 93/93 PASS |
| validation-runner contracts | 95/95 PASS |
| launcher contracts | 90/90 PASS |
| repository contracts | PASS |
| `validate.sh --no-smoke` | PASS |
| Environment Doctor v1 | `ENVIRONMENT_READY` |
| Agent Harness v1 | `HARNESS_COMPLETED` |
| provider / contract | Codex / 1 |
| provider version | `codex-cli 0.154.0` |
| capability fingerprint | `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441` |
| one-shot Luna/medium probe | `HARNESS_COMPLETED`; `PROBE_PASS`; zero retry; clean workspace; cleanup PASS |
| Environment v1 | READY |
| Agent Harness v1 qualification | READY |
| Pre-Pilot Rehearsal v5 | `PRE_PILOT_REHEARSAL_READY` |
| Pilot #1–#4 raw integrity | PASS before Case A |
| Pilot #6 raw integrity | PASS before Case A |

No rehearsal, R01–R13, qualification, broad audit, correction, or hardening was
run.

## Slice rendering

The normalized-to-launcher conversion validated `^slice-([0-9]{2,})$`, parsed
the captured digits as an integer, and serialized the unsigned decimal without
the `slice-` prefix or leading zeros. Each versioned launcher was rendered only
in memory for the preflight.

| Internal | Launcher input | EXECUTE | VALIDATE | APPLY |
|---|---:|---|---|---|
| `slice-01` | 1 | PASS | PASS | PASS |
| `slice-02` | 2 | PASS | PASS | PASS |
| `slice-10` | 10 | PASS | PASS | PASS |

Every rendering contained the expected numeric `SLICE=N` and none contained
`SLICE=slice-NN`. Case A stopped before the first live slice operation, so no
live per-operation slice-dispatch record was created and no slice model call
was spent.

## Finalization durability

| Case | Finalize exit | Output created? | Output status | Copied before cleanup? | Byte-identical? | Raw SHA-256 | Cleanup after persistence? |
|---|---:|---|---|---|---|---|---|
| A | 1 | yes | `BLOCKED` | yes | yes | `b6fb0f60a54e06095155fc60b01fef8ef8cabaf53f12ca1b07fb9340fdc80ab3` | yes |
| B | not run | no | not applicable | not applicable | not applicable | not applicable | not applicable |
| C | not run | no | not applicable | not applicable | not applicable | not applicable | not applicable |

The source and destination were both 2,392 bytes. JSON parsing and identity
checks passed for `caseId=A`, candidate SHA, `production-v2`, and
`status=BLOCKED`. Source and destination hashes matched before the owned
session root was removed. Finalize stdout reported the created `BLOCKED`
output; stderr contained only the documented non-PASS finalization message.

## Case A

- prepared baseline: `2026-09-17T18:22:47.420Z`
- first model-call start: `2026-09-17T18:22:47.424Z`
- finalization start: `2026-09-17T18:27:22.376Z`
- finalization completed: `2026-09-17T18:27:22.607Z`
- managed cleanup: PASS, after raw persistence and hash equality

| Event | Operation | Slice | Model / effort | Result | Resulting state |
|---:|---|---|---|---|---|
| 1 | `SPEC_INIT` | — | Sol / high | PASS | lifecycle `ready`; execution `EMPTY` |
| 2 | `PLAN` | — | Terra / high | BLOCKED | `EMPTY` |

The PLAN turn returned a concrete deterministic rejection for
`plans/slice-02.md` and invalid resolved path `plans/list`. The isolated
candidate was not published and the live workspace remained unchanged. There
was no PLAN re-entry, correction, REPLAN, slice execution, or product edit.

## Terminal forensic

Target: `src/cli.mjs`. Physical identity is SHA-256 over current file bytes.
The target existed and remained 1,318 bytes at every applicable boundary.

| Checkpoint | Physical SHA-256 | Recorded/Tested/Manifest SHA | State/Source |
|---|---|---|---|
| F00 | `d01942b7d13353ce01369c9d82a0a62c807b64e1ef05f3f9858d0e75506452cb` | unavailable | prepared baseline; local Case Git clean |
| F01–F07 | not applicable | not applicable | Case A stopped during PLAN before any slice execution or validation |
| F08 | `d01942b7d13353ce01369c9d82a0a62c807b64e1ef05f3f9858d0e75506452cb` | unavailable | finalizer input; execution `EMPTY`; terminal journal event = blocked PLAN |

No candidate-prepublication snapshot was invented. No task, Validation Attempt,
Effective Validation Base, tested-state hash, or final manifest existed.

## Forensic classification

`NOT_REPRODUCED`

The Pilot #5 terminal-integrity boundary was not reached. The applicable
physical snapshots of `src/cli.mjs` were byte-identical.

## Case B

`NOT_RUN — Case A canary did not PASS`

No B session, workspace, journal, result, TMPDIR, Git state, or model session
was created.

## Case C

`NOT_RUN — Case A canary did not PASS`

No C session, workspace, journal, result, TMPDIR, Git state, or model session
was created.

## Parallelism

Not applicable. Case A did not authorize B/C.

## Reviewer

`NOT_RUN — reviewer is not required after a blocked canary`

## Profile compliance

The raw reports `modelUse.profileMismatches=[]`, zero Sol escalations, and the
exact production-v2 assignments for both events. No child runner was started.
Both Harness calls completed with retry count zero.

## Operational repetition

| Fact | Value |
|---|---:|
| top-level workflow events | 2 |
| PLAN reviews | 0 |
| TASK reviews | 0 |
| REPLAN | 0 |
| EXECUTE calls | 0 |
| VALIDATE calls | 0 |
| APPLY_FINDINGS calls | 0 |
| findings cycles | 0 |
| mechanical rejections | 0 |
| external Harness retries | 0 |
| same-operation re-entry | 0 |

This incomplete canary does not provide sufficient real A/B/C evidence to
promote G2.

## Context pressure

The raw reports 0 PLAN bytes / 0 words and 0 TASKS bytes / 0 words because the
rejected planning candidate was never published. Actual token telemetry,
handoff bytes, and observable reads were unavailable and were not estimated.
G3 remains `PARTIAL`.

## Raw hashes

| Case | Raw | SHA-256 |
|---|---|---|
| A | `maintenance/benchmark-results/6de87f5d3d8f02ee27b8826942481c0529496291/case-a-production-v2.json` | `b6fb0f60a54e06095155fc60b01fef8ef8cabaf53f12ca1b07fb9340fdc80ab3` |
| B | not produced | not applicable |
| C | not produced | not applicable |

## Baseline

`OFFICIAL_E2E_BASELINE = NOT_YET_ESTABLISHED`

## Gates

| Gate | Before | After | Evidence |
|---|---|---|---|
| G1 | PROVEN | PROVEN | no objective regression |
| G2 | PARTIAL | PARTIAL | no complete qualified A/B/C workflow evidence |
| G3 | PARTIAL | PARTIAL | actual tokens/reads unavailable and no published plan/tasks metrics |
| G4 | PROVEN | PROVEN | frozen runner configuration unchanged; no runner call was needed |
| G5 | PROVEN | PROVEN | production-v2 PLAN dispatch matched Terra/high |
| G6 | NOT_YET_PROVEN | NOT_YET_PROVEN | Case A stopped before materialization and execution |

## P0

`P0_OPEN`

Objective residual: a qualified, complete A/B/C production workflow set is
still absent. The immediate observed blocker is PLAN candidate path resolution
to invalid `plans/list` in `plans/slice-02.md`. No correction is made in this
Pilot.

## Historical integrity

| Pilot | SHA-256 | Result |
|---|---|---|
| #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |
| #4 | `fa6b421fe4861a497f15f5432acfdb7f3b5d22e5e3c48780398181f6a794a202` | byte-identical; versioned canonical value used |
| #5 | raw historically unavailable | history unchanged; no raw invented |
| #6 | `6c2d421fbdc0aa7341a8874fe6e29e8de4fd557dcf739cbcb3f9c537e15e92f8` | byte-identical |

## Source mutation guard

PASS immediately before raw/evidence persistence:

- HEAD remained `6de87f5d3d8f02ee27b8826942481c0529496291`;
- tree remained `90cb1ed9db9331bd676af7056ba11ed72c355c99`;
- working tree remained clean;
- `git diff --check` passed;
- candidate functional bytes were not modified by the Pilot.

After live execution, source-checkout changes are confined to the authorized
Pilot #7 raw and evidence/results/checkpoint bookkeeping.

## Resulting commit

`pending user commit`
