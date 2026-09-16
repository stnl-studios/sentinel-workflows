# S3 Benchmark Correction 01

## Base

`577928c5af65df0f61782f3e907a222899eb7557`

## Trigger

Pilot #1: `S3_BENCHMARK_PILOT_BLOCKED`

## Root causes

- Case requirements were insufficiently observable for an autonomous INIT
  ready claim.
- `SPEC_READINESS` was incorrectly mapped to `SPEC` in the collector.
- `prepare` omitted the empty `specs/` parent and induced an artificial INIT
  retry.

## Corrections

- A/B/C behavioral authority matured.
- `SPEC_READINESS` now maps to `REVIEW_VALIDATE`.
- The parent `specs/` is prepared while the selected SPEC path remains absent.
- `compare` prevents cross-requirements, seed, or profile comparisons.

## Preserved

- Production Profile.
- Budgets.
- Benchmark version.
- Seed.
- Sentinel skills and runtime.
- Historical BLOCKED result.

## Status

`BENCHMARK_CORRECTION_01_READY_FOR_REPILOT`

## Resulting commit

`6b193cdd751d7d772d2288709169913f8e8c30e7`
