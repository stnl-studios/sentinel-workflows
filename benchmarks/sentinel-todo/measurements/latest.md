# Sentinel todo benchmark measurement

- Run: run-20260930173938-ca7e2ae2
- Status: BLOCKED; mode: full; profile: production-v2
- Time: 2026-09-30T17:39:39.213Z → 2026-09-30T18:03:01.589Z
- HEAD: e21a8354a0adce39a3827e8235792323492ad548; dirty: false; functional diff: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
- Source identity: sha256:b8d8888da21f3c3befd5608783d4497167ac412062fcb17aedf1a87a48506d27; snapshot: sha256:a0001c1a68856476ebad73ee45e5bda83554d2ecf1440369d98698f4119d1a45
- Snapshot created: 2026-09-30T17:39:39.201Z

| Case | State | Blocker | Finalizer | Final tests | Spec closed | Official state | Operations | Main / runner turns | Duration ms | Slices |
|---|---|---|---|---|---|---|---:|---:|---:|---|
| A | BLOCKED | OFFICIAL_TRANSITION_NOT_OBSERVED | FAIL (exit 1) | true | false | EXECUTION_STARTED | 6 | 6 / 1 | 1401882 | 1 |
| B | NOT_RUN | unavailable | unavailable (exit unavailable) | unavailable | unavailable | unavailable | 0 | 0 / 0 | unavailable | unavailable |
| C | NOT_RUN | unavailable | unavailable (exit unavailable) | unavailable | unavailable | unavailable | 0 | 0 / 0 | unavailable | unavailable |

## Measured totals

- Operations: 6; recovery operations: 0; happy path operations: 6
- Main turns: 6; runner turns: 1; extra runner turns: 0
- Repeated reviews: 0; repeated execute/validate: 0 / 0
- Duration total / summed cases (ms): 1402376 / unavailable
- Telemetry coverage main / runner: 6/6 / 1/1
- main tokens (input/output/cached input/reasoning output): 4728333 / 50485 / 4374016 / 16753
- main observed input/output tokens: 4728333 / 50485
- runner tokens (input/output/cached input/reasoning output): 98912 / 1447 / 60416 / 423
- runner observed input/output tokens: 98912 / 1447
- Cached input and reasoning output are subcategories, not additional tokens. Input per turn is a context-pressure proxy, not measured window occupancy or billing.

## Comparison

- Reason: partial-run; no savings conclusion
- Deltas versus baseline-v1: unavailable
- Historical JSON: [run-20260930173938-ca7e2ae2.json](run-20260930173938-ca7e2ae2.json)

## Case evidence

- A: BLOCKED; blocker OFFICIAL_TRANSITION_NOT_OBSERVED; terminal BLOCKED; blocking operation {"operation":"EXECUTE_SLICE","slice":"slice-01","result":"BLOCKED"}; finalizer FAIL; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":1,"VALIDATE_SLICE":0,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":0,"applyFindings":0}}; telemetry coverage main 6/6, runner 1/1.
- B: NOT_RUN; blocker unavailable; terminal NOT_RUN; blocking operation "unavailable"; finalizer unavailable; final tests unavailable (unavailable, exit unavailable); operations {"EXECUTE_SLICE":0,"VALIDATE_SLICE":0,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":0,"REVIEW_TASKS":0}; slices {}; telemetry coverage main 0/0, runner 0/0.
- C: NOT_RUN; blocker unavailable; terminal NOT_RUN; blocking operation "unavailable"; finalizer unavailable; final tests unavailable (unavailable, exit unavailable); operations {"EXECUTE_SLICE":0,"VALIDATE_SLICE":0,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":0,"REVIEW_TASKS":0}; slices {}; telemetry coverage main 0/0, runner 0/0.
