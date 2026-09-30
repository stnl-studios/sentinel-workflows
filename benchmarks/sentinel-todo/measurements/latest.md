# Sentinel todo benchmark measurement

- Run: run-20260930151848-f90e1696
- Status: BLOCKED; mode: full; profile: production-v2
- Time: 2026-09-30T15:18:49.388Z → 2026-09-30T17:14:11.515Z
- HEAD: b0a01bad5a790f342685c01f8e700b509b1aa225; dirty: false; functional diff: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
- Source identity: sha256:b8d8888da21f3c3befd5608783d4497167ac412062fcb17aedf1a87a48506d27; snapshot: sha256:a0001c1a68856476ebad73ee45e5bda83554d2ecf1440369d98698f4119d1a45
- Snapshot created: 2026-09-30T15:18:49.373Z

| Case | State | Blocker | Finalizer | Final tests | Spec closed | Official state | Operations | Main / runner turns | Duration ms | Slices |
|---|---|---|---|---|---|---|---:|---:|---:|---|
| A | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 10 | 10 / 4 | 2208506 | 2 |
| B | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 16 | 16 / 11 | 4712665 | 3 |
| C | BLOCKED | SDK_TURN_FAILED | FAIL (exit 1) | true | false | PLANNED_READY | 4 | 4 / 0 | 2525037 | 4 |

## Measured totals

- Operations: 30; recovery operations: 1; happy path operations: 29
- Main turns: 30; runner turns: 15; extra runner turns: 3
- Repeated reviews: 0; repeated execute/validate: 0 / 1
- Duration total / summed cases (ms): 6922127 / 9446208
- Telemetry coverage main / runner: 29/30 / 15/15
- main tokens (input/output/cached input/reasoning output): unavailable / unavailable / unavailable / unavailable
- main observed input/output tokens: 49817617 / 245882
- runner tokens (input/output/cached input/reasoning output): 1882660 / 28620 / 1494528 / 7745
- runner observed input/output tokens: 1882660 / 28620
- Cached input and reasoning output are subcategories, not additional tokens. Input per turn is a context-pressure proxy, not measured window occupancy or billing.

## Comparison

- Reason: partial-run; no savings conclusion
- Deltas versus baseline-v1: unavailable
- Historical JSON: [run-20260930151848-f90e1696.json](run-20260930151848-f90e1696.json)

## Case evidence

- A: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":2,"VALIDATE_SLICE":2,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 10/10, runner 4/4.
- B: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":3,"VALIDATE_SLICE":4,"APPLY_FINDINGS":1,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":2,"applyFindings":1},"slice-03":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 16/16, runner 11/11.
- C: BLOCKED; blocker SDK_TURN_FAILED; terminal BLOCKED; blocking operation {"operation":"MATERIALIZE_TASKS","slice":"unavailable","result":"BLOCKED"}; finalizer FAIL; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":0,"VALIDATE_SLICE":0,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":0}; slices {}; telemetry coverage main 3/4, runner 0/0.
