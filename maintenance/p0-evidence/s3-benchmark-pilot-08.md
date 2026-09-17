# S3 Production Benchmark Pilot 08

## Status

`PRODUCTION_PILOT_08_BLOCKED_CASE_A`

Case A completed one Sol/high `SPEC_INIT` model turn. The turn published a
structurally valid lifecycle SPEC with status `ready`; the official execution
readback independently derived `EMPTY` with legal handoff `PLAN`.

The external measurement driver then misclassified the canonical File Purpose
Header. It looked for a list-form `- status: ready` line instead of the actual
fenced YAML field `status: ready`, recorded the event as `BLOCKED`, and
terminalized the Case before PLAN. This is an orchestration/measurement
blocker, not a Sentinel candidate blocker.

The zero-rerun stop policy was honored. No second INIT, PLAN, correction,
rehearsal, Case B, Case C, or reviewer was started. Canonical finalization
produced a truthful raw for the recorded journal, and that raw was preserved
byte-for-byte before managed cleanup.

## Candidate

- branch: `feature/atlas-p0`
- candidate: `0be86e69801f51ae32612275bb31f8823b52a5bf`
- parent: `c0efb3f7a38897c545798cb0ac57599b5fc240da`
- commit: `docs(planning): record live observability pass`
- tree: `a317e59d4a1aedcee0896c2623c93ccaad922fdd`
- Production Profile: `production-v2`
- published `origin/feature/atlas-p0`: candidate SHA confirmed
- initial working tree: clean, with no relevant untracked files

The parent-to-candidate diff contains only PLAN live-observability evidence,
the P0 evidence index, and checkpoint bookkeeping. No skill, planner template,
runtime, agent, launcher, functional script, benchmark runtime, Environment,
Harness, Case, seed, profile/config, or schema changed. The functional
checkpoint and candidate are equivalent for Production Pilot execution.

## Preconditions

| Check | Result |
|---|---|
| branch / HEAD / parent / commit subject | PASS |
| published branch HEAD | PASS |
| clean source checkout / `git diff --check` | PASS |
| functional-equivalence gate | PASS — evidence/index/checkpoint only |
| Pilot #8 output collision guard | PASS — candidate directory absent |
| benchmark authority = `production-v2` | PASS |
| benchmark verify | PASS |
| seed tests | 8/8 PASS |
| benchmark contracts | 9/9 PASS |
| Environment deterministic tests | 5/5 PASS |
| Agent Harness deterministic tests | 24/24 PASS |
| execution contracts | 94/94 PASS |
| validation-runner contracts | 95/95 PASS |
| launcher contracts | 90/90 PASS |
| repository contracts | 3/3 PASS |
| `validate.sh --no-smoke` | PASS |
| Environment Doctor v1 | `ENVIRONMENT_READY` |
| Agent Harness v1 | `HARNESS_COMPLETED` |
| provider / contract | Codex / 1 |
| provider version | `codex-cli 0.154.0` |
| capability fingerprint | `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441` |
| one-shot Luna/medium probe | `HARNESS_COMPLETED`; `PROBE_PASS`; one command exit 0; zero retry; clean workspace; cleanup PASS |
| Environment v1 | READY |
| Agent Harness v1 qualification | READY |
| Pre-Pilot Rehearsal v5 | `PRE_PILOT_REHEARSAL_READY` |
| PLAN live observability v1 | `PLAN_LIVE_OBSERVABILITY_PASS` |
| Pilot #1–#4, #6, and #7 raw integrity | PASS before Case A |

No rehearsal, R01–R13, PLAN observability rerun, SPEC qualification, broad
audit, hardening, or Sentinel correction ran.

## Orchestration guards

- numeric slice rendering: no live slice operation was reached; no slice
  launcher input was emitted;
- durable finalize: PASS — output existence, JSON parse, identity, status,
  source hash, destination hash, and byte equality were checked before cleanup;
- outer retry: zero;
- same-operation driver re-entry: zero;
- sibling policy: not applicable because the canary did not authorize B/C.

## Case A

- prepared baseline: `2026-09-17T20:14:50.689Z`
- first model-call start: `2026-09-17T20:14:50.721Z`
- model-call completion / Case terminalization: `2026-09-17T20:18:00.739Z`
- managed cleanup: PASS, after durable raw staging and hash equality

| Event | Operation | Model / effort | Harness | Observed Sentinel result | Recorded journal result |
|---:|---|---|---|---|---|
| 1 | `SPEC_INIT` | Sol / high | `HARNESS_COMPLETED` | lifecycle `ready`; execution `EMPTY`; legal `PLAN` | `BLOCKED` due external parser defect |

The model turn ran ten commands, all with exit `0`, and reported structural and
semantic global PASS. The official execution runtime confirmed the resulting
`EMPTY` state and the normal `PLAN` handoff. Because the driver had already
recorded the event incorrectly, the Case was finalized and not resumed.

## Terminal-integrity forensic

`NOT_REPRODUCED`

`src/cli.mjs` existed and remained 1,318 bytes with physical SHA-256
`d01942b7d13353ce01369c9d82a0a62c807b64e1ef05f3f9858d0e75506452cb`
at H0 and both H5 boundaries. H1–H4 were not applicable because no EXECUTE or
VALIDATE operation started. No Validation Attempt, Effective Validation Base,
tested-state manifest, or terminal implementation readback existed.

## Parallel authorization

- A canonical PASS: not achieved;
- B authorization: not issued;
- C authorization: not issued.

## Case B

`NOT_RUN — Case A canonical PASS gate was not satisfied`

## Case C

`NOT_RUN — Case A canonical PASS gate was not satisfied`

## Parallelism

Not applicable. No B/C session, workspace, journal, model session, or
authorization timestamp was created.

## Reviewer

`NOT_RUN — reviewer is not required after a blocked canary`

## Profile compliance

The raw reports `profileMismatches=[]`. The only top-level dispatch was the
expected GPT-5.6-Sol/high SPEC operation. No child runner was started, no model
or effort was substituted, and outer retry remained zero.

## Operational repetition

| Fact | Value |
|---|---:|
| top-level workflow events | 1 |
| PLAN reviews | 0 |
| TASK reviews | 0 |
| REPLAN | 0 |
| EXECUTE calls | 0 |
| VALIDATE calls | 0 |
| APPLY_FINDINGS calls | 0 |
| findings cycles | 0 |
| mechanical rejections | 0 |
| outer Harness retries | 0 |
| forbidden/manual re-entry | 0 |

The incomplete canary cannot promote G2.

## Context pressure

The raw reports 0 PLAN bytes/words and 0 TASKS bytes/words because execution
stopped before PLAN. Actual input/output token telemetry, handoff bytes, and
observable reads were unavailable and were not estimated. G3 remains
`PARTIAL`.

## Raw hashes

| Case | Raw | SHA-256 |
|---|---|---|
| A | `maintenance/benchmark-results/0be86e69801f51ae32612275bb31f8823b52a5bf/case-a-production-v2.json` | `31ba5fb8de3bfcb32235b72d54c9e293a72fab0bbefdf11566ab83633b631b9c` |
| B | not produced | not applicable |
| C | not produced | not applicable |

The source and destination were both 2,340 bytes and byte-identical. Canonical
`finalize` exited `1` only because the created raw status was `BLOCKED`.

## Baseline

`OFFICIAL_E2E_BASELINE = NOT_YET_ESTABLISHED`

## Gates

| Gate | Before | After | Evidence |
|---|---|---|---|
| G1 | PROVEN | PROVEN | no objective regression |
| G2 | PARTIAL | PARTIAL | no complete A/B/C workflow evidence |
| G3 | PARTIAL | PARTIAL | no PLAN/TASKS metrics or actual token/read telemetry |
| G4 | PROVEN | PROVEN | frozen runner configuration unchanged; no runner call started |
| G5 | PROVEN | PROVEN | no PLAN/TASKS dispatch occurred; prior proof unchanged |
| G6 | NOT_YET_PROVEN | NOT_YET_PROVEN | workflow stopped after SPEC_INIT |

## P0

`P0_OPEN`

Objective residual: Production Pilot #8 lacks a canonical Case A PASS and any
B/C execution because the external measurement driver terminalized the canary
after misreading the canonical lifecycle status field.

## Historical integrity

PASS. The versioned repository authorities for Pilots #1–#4, #6, and #7 match
the existing raw bytes. Pilot #5 remains historically unavailable; no raw was
invented or reconstructed.

## Source mutation guard

PASS before authorized raw/evidence persistence:

- HEAD remained `0be86e69801f51ae32612275bb31f8823b52a5bf`;
- tree remained `a317e59d4a1aedcee0896c2623c93ccaad922fdd`;
- working tree remained clean;
- `git diff --check` passed;
- no candidate functional byte was modified by the Pilot.

After the guard, checkout changes are confined to the authorized Pilot #8 raw,
evidence, index, results README, checkpoint, and prior resulting-commit
bookkeeping.

## Resulting commit

`pending user commit`
