# S3 Production Benchmark Pilot 05

## Status

`PRODUCTION_PILOT_05_BLOCKED_FINALIZATION`

Case A reached the final `VALIDATE_SLICE` for `slice-02`. The top-level turn
reported PASS, but the required official strict readback rejected terminal
integrity for `src/cli.mjs`: the Effective Validation Base expected
`sha256:c54337c1009d7785d71c0cf5279fe85f6f037636cdf04191f8f598abf2be7e9b`
while the current file was
`sha256:c54337c1009d7785d71c0cf52785fe9f6f037636cdf04191f8f598abf2be7e9b`.
The journal therefore recorded the operation as `BLOCKED` and B/C were not
authorized.

The canonical collector created a Case A result with status `BLOCKED` in the
managed Case root and returned its documented non-zero blocked exit. The Pilot
driver incorrectly treated that exit as absence of a result and cleaned the
owned root before copying the raw. No raw reconstruction or rerun was performed.
Because raw persistence and hashing could not be completed, finalization is the
consolidated blocker.

## Candidate

- branch: `feature/atlas-p0`
- candidate: `1ad5a1b327d1bfbe3c8b2e6c6e987e649ead5f13`
- parent: `b1fb9e182c15a2442aba09872cf11f3e6d49dd13`
- commit: `fix(execution): enforce canonical execution evidence`
- published branch HEAD: confirmed
- initial tree: `495946f6cac26ed0fba6363c7b32461522b28fec`
- initial working tree: clean, with no relevant untracked files

## Profile

`production-v2`

## Preconditions

| Check | Result |
|---|---|
| branch / HEAD / parent / commit subject | PASS |
| published `origin/feature/atlas-p0` HEAD | PASS |
| clean source checkout / `git diff --check` | PASS |
| benchmark authority = `production-v2` | PASS |
| benchmark verify | PASS |
| seed tests | 8/8 PASS |
| benchmark contracts | 9/9 PASS |
| Environment deterministic tests | 5/5 PASS |
| Agent Harness deterministic tests | 24/24 PASS |
| execution contracts | 95/95 PASS |
| validation-runner contracts | 95/95 PASS |
| launcher contracts | 90/90 PASS |
| repository contracts | 3/3 PASS |
| `validate.sh --no-smoke` | PASS |
| Environment Doctor v1 | `ENVIRONMENT_READY` |
| Agent Harness v1 | `HARNESS_COMPLETED` |
| provider / contract | Codex / 1 |
| provider version | `codex-cli 0.154.0` |
| capability fingerprint | `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441` |
| one-shot Luna/medium probe | `HARNESS_COMPLETED`; semantic PASS; zero retry |
| Pre-Pilot Rehearsal v5 | `PRE_PILOT_REHEARSAL_READY` |
| Pilot #1–#4 integrity | PASS before Case A |

No rehearsal, R01–R13 run, qualification, broad audit, or hardening was executed.
One deterministic precondition command was initially invoked from the wrong
working directory and failed before touching state; the canonical absolute-path
checks then passed. This was not a model session or an outer Harness retry.

## Case A

- session start: `2026-09-17T16:34:21.097Z`
- first model-call start: `2026-09-17T16:34:21.103Z`
- terminal: `2026-09-17T17:11:03.038Z`
- collector outcome emitted before cleanup: `BLOCKED`
- persisted Pilot raw: unavailable because finalization copying failed
- raw SHA-256: unavailable; never predicted or reconstructed

| Event | Operation | Slice | Model / effort | Result | Resulting state |
|---:|---|---|---|---|---|
| 1 | `SPEC_INIT` | — | Sol / high | PASS | `ready` |
| 2 | `PLAN` | — | Terra / high | PASS | `PLANNED_DRAFT` |
| 3 | `REVIEW_PLAN` | — | Luna / high | PASS | `PLANNED_READY` |
| 4 | `MATERIALIZE_TASKS` | — | Terra / high | PASS | `MATERIALIZED_PRISTINE` |
| 5 | `REVIEW_TASKS` | — | Luna / high | PASS | `MATERIALIZED_PRISTINE` |
| 6 | `EXECUTE_SLICE` | `slice-01` | Luna / high | PASS | `IMPLEMENTED_AWAITING_VALIDATION` |
| 7 | `VALIDATE_SLICE` | `slice-01` | Luna / high | PASS | `EXECUTION_STARTED` |
| 8 | `EXECUTE_SLICE` | `slice-02` | Luna / high | PASS | `IMPLEMENTED_AWAITING_VALIDATION` |
| 9 | `VALIDATE_SLICE` | `slice-02` | Luna / high | BLOCKED | official terminal readback rejected |

Both implementation operations completed their auxiliary check in round `1/3`.
Both validation turns started their configured Luna/medium runner and reported
formal PASS, but event 9 could not survive the mandatory strict readback. The
runtime exposed only a `REPLAN` terminal-integrity recovery target. The driver
did not enter it, did not retry validation, and did not initiate another Case
operation.

Top-level expected and requested model/effort matched for all nine events. No
fallback or substitution was used. The unpreserved collector raw means its
`profileMismatches` field cannot be independently inspected; the driver event
record observed zero mismatches.

## Parallel authorization

- A PASS timestamp: not applicable; Case A did not canonically PASS
- B authorization timestamp: not emitted
- C authorization timestamp: not emitted

## Case B

`NOT_RUN — Case A canary did not PASS`

No B session root, workspace, journal, result, runner-tmp, TMPDIR, Git state, or
model session was created.

## Case C

`NOT_RUN — Case A canary did not PASS`

No C session root, workspace, journal, result, runner-tmp, TMPDIR, Git state, or
model session was created.

## Parallelism proof

Not applicable. B/C were never authorized, so no overlap is claimed.

## Reviewer

`NOT_RUN — reviewer is not required after a blocked canary`

No reviewer model session or retry was created.

## Operational repetition

| Fact | Value |
|---|---:|
| top-level workflow events | 9 |
| PLAN reviews | 1 |
| TASK reviews | 1 |
| REPLAN | 0 |
| EXECUTE calls | 2 |
| VALIDATE calls | 2 |
| APPLY_FINDINGS calls | 0 |
| automatic correction rounds | 0 |
| external Harness retries | 0 |
| driver re-entry after valid BLOCKED | 0 |
| redundant stage repetitions | 0 |

G2 remains `PARTIAL`. The canary showed no retry or redundant stage repetition,
but there is no complete qualified A/B/C evidence set and no preserved raw from
which to evaluate the authoritative production criteria.

## Context pressure

Case A used one isolated managed session and one top-level session per operation.
Executor and validator prompts required independent custom-runner sessions with
no inherited conversation history and compact operation-local payloads. Actual
token telemetry was unavailable. Because the canonical raw was not preserved,
PLAN/TASKS byte and word metrics are also unavailable for the Pilot record.

G3 remains `PARTIAL`; no token count, percentage reduction, or unmeasured
estimate is claimed.

## Baseline

`OFFICIAL_E2E_BASELINE = NOT_YET_ESTABLISHED`

No partial or unpersisted result is used as an official baseline.

## Gates

| Gate | Before | After | Evidence |
|---|---|---|---|
| G1 | PROVEN | PROVEN | no objective regression |
| G2 | PARTIAL | PARTIAL | no complete qualified A/B/C production evidence |
| G3 | PARTIAL | PARTIAL | no complete metrics set; actual tokens unavailable |
| G4 | PROVEN | PROVEN | frozen runner model remained Luna/medium |
| G5 | PROVEN | PROVEN | frozen PLAN/TASKS profile remained compliant |
| G6 | NOT_YET_PROVEN | NOT_YET_PROVEN | Case A did not complete canonical close; B/C not run |

## P0

`P0_OPEN`

Objective residual: a qualified, persisted production execution set is absent;
G2 and G3 lack their complete production evidence, and G6 lacks a complete real
workflow proof.

## Historical integrity

| Pilot | SHA-256 | Result before A | Result after live Pilot |
|---|---|---|---|
| #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical | byte-identical |
| #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical | byte-identical |
| #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical | byte-identical |
| #4 | `fa6b421fe4861a497f15f5432acfdb7f3b5d22e5e3c48780398181f6a794a202` | byte-identical | byte-identical |

## Source mutation guard

PASS before evidence persistence:

- HEAD remained `1ad5a1b327d1bfbe3c8b2e6c6e987e649ead5f13`;
- tree remained `495946f6cac26ed0fba6363c7b32461522b28fec`;
- working tree remained clean;
- `git diff --check` passed.

After live execution, source-checkout changes are confined to authorized P0
evidence and benchmark results bookkeeping.

## Pilot #5 raw hashes

| Case | Raw | SHA-256 |
|---|---|---|
| A | not preserved; no placeholder created | unavailable |
| B | not produced | not applicable |
| C | not produced | not applicable |

## Resulting commit

`a546cfe1ddad925da75af6d46e7722549208342a`
