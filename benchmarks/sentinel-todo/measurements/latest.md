# Sentinel todo benchmark measurement

- Run: run-20260930130114-e85e1d4f
- Status: PASS; mode: full; profile: production-v2
- Time: 2026-09-30T13:01:15.445Z → 2026-09-30T14:56:25.668Z
- HEAD: 7bc9e94bcf0eeaaee75482bce6b9eae753fed739; dirty: true; functional diff: sha256:bb483013b7b2b7cad5ac05002b70ff5a0a1ede1ff1e2d2738d4269199336e051
- Source identity: sha256:b8d8888da21f3c3befd5608783d4497167ac412062fcb17aedf1a87a48506d27; snapshot: sha256:a0001c1a68856476ebad73ee45e5bda83554d2ecf1440369d98698f4119d1a45
- Snapshot created: 2026-09-30T13:01:15.430Z

| Case | State | Blocker | Finalizer | Final tests | Spec closed | Official state | Operations | Main / runner turns | Duration ms | Slices |
|---|---|---|---|---|---|---|---:|---:|---:|---|
| A | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 8 | 8 / 2 | 1925701 | 1 |
| B | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 10 | 10 / 4 | 2506119 | 2 |
| C | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 14 | 14 / 11 | 4983195 | 3 |

## Measured totals

- Operations: 32; recovery operations: 1; happy path operations: 31
- Main turns: 32; runner turns: 17; extra runner turns: 3
- Repeated reviews: 0; repeated execute/validate: 0 / 1
- Duration total / summed cases (ms): 6910223 / 9415015
- Telemetry coverage main / runner: 32/32 / 17/17
- main tokens (input/output/cached input/reasoning output): 52558099 / 320520 / 50351744 / 106666
- main observed input/output tokens: 52558099 / 320520
- runner tokens (input/output/cached input/reasoning output): 1936886 / 30559 / 1493504 / 9372
- runner observed input/output tokens: 1936886 / 30559
- Cached input and reasoning output are subcategories, not additional tokens. Input per turn is a context-pressure proxy, not measured window occupancy or billing.

## Comparison

- Reason: compatible reports
- Deltas versus baseline-v1: {"g2":{"operations":-4,"recoveryOperations":1,"extraRunnerTurns":2,"repeatedReviewRounds":0,"repeatedExecuteAttempts":0,"repeatedValidateAttempts":1},"g3":{"mainInputTokens":9680154,"mainOutputTokens":54745,"runnerInputTokens":-173451,"runnerOutputTokens":-4814,"peakInputPerTurn":9902648,"medianInputPerTurn":82105}}
- Historical JSON: [run-20260930130114-e85e1d4f.json](run-20260930130114-e85e1d4f.json)

## Case evidence

- A: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":1,"VALIDATE_SLICE":1,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 8/8, runner 2/2.
- B: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":2,"VALIDATE_SLICE":2,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 10/10, runner 4/4.
- C: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":3,"VALIDATE_SLICE":4,"APPLY_FINDINGS":1,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":2,"applyFindings":1},"slice-02":{"execute":1,"validate":1,"applyFindings":0},"slice-03":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 14/14, runner 11/11.
