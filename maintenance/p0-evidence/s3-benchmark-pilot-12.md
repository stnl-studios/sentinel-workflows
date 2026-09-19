# Production Pilot #12

## Status

BLOCKED.

## Candidate

- SHA: `84ea82fef528487b0d3b0472def1199c277b340e`
- Profile: `production-v2`
- Driver: `benchmark-production-pilot.mjs`, `driverVersion: 2`

## Preconditions

PASS. Official `preconditions.json` reported `PASS`; the source guard confirmed
the required branch, HEAD, parent, published ref, clean tree, and
`git diff --check` PASS.

## Case A

- Status: `BLOCKED`
- Operations: `8`
- Blocker: `OFFICIAL_TRANSITION_NOT_OBSERVED`
- Terminal operation: `EXECUTE_SLICE`, `slice-02`, operation 8
- Official state: `EXECUTION_STARTED`
- Retry count: `0`
- Raw: `maintenance/benchmark-results/84ea82fef528487b0d3b0472def1199c277b340e/case-a-production-v2.json`
- Raw SHA-256: `c416b19ef4bf147ad87deb190987b3fc88656f6ffc8154bae11b42f357ff2631`
- Causal artifact: none preserved by the driver (`blockerArtifact: null`)

The terminal operation evidence records `TESTS_PASS` round `1/3`, then
candidate validation `BLOCKED` with exit `1`; no live record was published and
no retry, formal validation, or later operation was started.

## Case B

`NOT_RUN` because Case A blocked.

## Case C

`NOT_RUN` because Case A blocked.

## Recovery behavior observed

- Review-plan rounds: `1`.
- Review-tasks rounds: `1`.
- Execute calls: `2`.
- Validate calls: `1`.
- Apply-findings calls: `0`.
- Findings cycles: `0`.
- Internal retries: `0`.
- Outer retries: `0`.

No recovery loop or correction was observed.

## Profile compliance

Profile mismatches: `[]`. Observed phase assignments were Sol/high for SPEC,
Terra/high for PLAN and TASKS, and Luna/high for EXECUTE and REVIEW_VALIDATE.
Sol escalations: `0`.

## Operational repetition

The raw reports 3 slices, 7 tasks, 8 operations, 1 review-plan round,
1 review-tasks round, 2 execute calls, 1 validate call, 0 replans, and 0
retries.

## Context pressure

Available metrics were plan `11,413` bytes / `1,548` words and tasks `12,140`
bytes / `1,586` words. Handoff bytes and observable reads were unavailable;
actual token telemetry was unavailable. No token count is estimated.

## Blocker causal

Case A / operation 8 / `EXECUTE_SLICE` / `slice-02` reached
`OFFICIAL_TRANSITION_NOT_OBSERVED`. The preserved terminal evidence identifies
candidate validation as blocked (exit `1`); the official driver preserved no
causal blocker artifact. No further inference is made.

## Integrity

- Historical raw integrity: `true`.
- Source tracked integrity: `true`.
- Candidate raw observed SHA matches the official summary: `true`.

## Baseline

`NOT_YET_ESTABLISHED`.

## P0 gates

| Gate | Before | After | Evidence |
|---|---|---|---|
| G1 | PROVEN | PROVEN | Existing P0 ledger; no change in this blocked Pilot |
| G2 | PARTIAL | PARTIAL | Pilot did not complete A/B/C; raw repetition metrics preserved |
| G3 | PARTIAL | PARTIAL | Plan/task byte and word metrics preserved; token telemetry unavailable |
| G4 | PROVEN | PROVEN | Profile-compliant runner evidence in raw |
| G5 | PROVEN | PROVEN | Profile-compliant PLAN/TASKS evidence in raw |
| G6 | NOT_YET_PROVEN | NOT_YET_PROVEN | A blocked; B/C not run; baseline ineligible |

P0: `P0_OPEN`.

