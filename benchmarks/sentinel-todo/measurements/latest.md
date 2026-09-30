# Sentinel todo benchmark measurement

- Run: run-20260930183513-d0009216
- Status: PASS; mode: full; profile: production-v2
- Time: 2026-09-30T18:35:13.703Z → 2026-09-30T20:14:19.687Z
- HEAD: 02c1a931488f00962c640380fced16fb66ec967c; dirty: true; functional diff: sha256:ec3e1899b34f3b3e31eee23465c83b494aa4124cad38d4715ac5ae48c5cb2eb1
- Source identity: sha256:caecab11fa18f8c806f0cb66b811a85875348be644ca412d5ee8d497e0ef8729; snapshot: sha256:8ef0ee865c6e071c00188b20c8225d01a1d84eb5c90c5940f64d53eca3e8a277
- Snapshot created: 2026-09-30T18:35:13.690Z

| Case | State | Blocker | Finalizer | Final tests | Spec closed | Official state | Operations | Main / runner turns | Duration ms | Slices |
|---|---|---|---|---|---|---|---:|---:|---:|---|
| A | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 13 | 13 / 7 | 2668463 | 2 |
| B | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 15 | 15 / 9 | 3101070 | 3 |
| C | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 14 | 14 / 9 | 3276091 | 3 |

## Measured totals

- Operations: 42; recovery operations: 5; happy path operations: 37
- Main turns: 42; runner turns: 25; extra runner turns: 1
- Repeated reviews: 0; repeated execute/validate: 0 / 3
- Duration total / summed cases (ms): 5945984 / 9045624
- Telemetry coverage main / runner: 42/42 / 25/25
- main tokens (input/output/cached input/reasoning output): 71091730 / 345349 / 68598144 / 105684
- main observed input/output tokens: 71091730 / 345349
- runner tokens (input/output/cached input/reasoning output): 3337367 / 46596 / 2627072 / 14363
- runner observed input/output tokens: 3337367 / 46596
- Cached input and reasoning output are subcategories, not additional tokens. Input per turn is a context-pressure proxy, not measured window occupancy or billing.

## Comparison

- Reason: compatible reports
- Deltas versus baseline-v1: {"g2":{"operations":6,"recoveryOperations":5,"extraRunnerTurns":0,"repeatedReviewRounds":0,"repeatedExecuteAttempts":0,"repeatedValidateAttempts":3},"g3":{"mainInputTokens":28213785,"mainOutputTokens":79574,"runnerInputTokens":1227030,"runnerOutputTokens":11223,"peakInputPerTurn":3539085,"medianInputPerTurn":-100224}}
- Historical JSON: [run-20260930183513-d0009216.json](run-20260930183513-d0009216.json)

## Case evidence

- A: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":2,"VALIDATE_SLICE":3,"APPLY_FINDINGS":2,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":2,"applyFindings":2}}; telemetry coverage main 13/13, runner 7/7.
- B: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":3,"VALIDATE_SLICE":4,"APPLY_FINDINGS":2,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":1,"applyFindings":0},"slice-03":{"execute":1,"validate":2,"applyFindings":2}}; telemetry coverage main 15/15, runner 9/9.
- C: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":3,"VALIDATE_SLICE":4,"APPLY_FINDINGS":1,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":2,"applyFindings":1},"slice-02":{"execute":1,"validate":1,"applyFindings":0},"slice-03":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 14/14, runner 9/9.
