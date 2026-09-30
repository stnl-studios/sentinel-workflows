# Sentinel todo benchmark measurement

- Run: run-20260930004635-bc76d6a3
- Status: PASS; mode: full; profile: production-v2
- Time: 2026-09-30T00:46:35.720Z → 2026-09-30T02:26:19.457Z
- HEAD: 45fcb4d6dbf278244d1cd642431f6f69ae5271f9; dirty: true; functional diff: sha256:8e5271427949220d56c63ef1286bbf902d38f6351e3e681d5b29e9389c95f536
- Source identity: sha256:00d33d05017881d6d50756b152ae355c246f1b143428005cc0b1439273b4c0a9; snapshot: sha256:5406735452309515f3c5a61ab43c11693d5b6748991831ff629c01de20fb3eed
- Snapshot created: 2026-09-30T00:46:35.709Z

| Case | State | Blocker | Finalizer | Final tests | Spec closed | Official state | Operations | Main / runner turns | Duration ms | Slices |
|---|---|---|---|---|---|---|---:|---:|---:|---|
| A | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 12 | 12 / 8 | 2679043 | 3 |
| B | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 14 | 14 / 11 | 3180832 | 2 |
| C | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 12 | 12 / 6 | 3303648 | 3 |

## Measured totals

- Operations: 38; recovery operations: 2; happy path operations: 36
- Main turns: 38; runner turns: 25; extra runner turns: 5
- Repeated reviews: 0; repeated execute/validate: 0 / 2
- Duration total / summed cases (ms): 5983737 / 9163523
- Telemetry coverage main / runner: 38/38 / 25/25
- main tokens (input/output/cached input/reasoning output): 65236562 / 324696 / 62686592 / 97156
- main observed input/output tokens: 65236562 / 324696
- runner tokens (input/output/cached input/reasoning output): 2295544 / 40396 / 1644032 / 13417
- runner observed input/output tokens: 2295544 / 40396
- Cached input and reasoning output are subcategories, not additional tokens. Input per turn is a context-pressure proxy, not measured window occupancy or billing.

## Comparison

- Reason: compatible reports
- Deltas versus baseline-v1: {"g2":{"operations":2,"recoveryOperations":2,"extraRunnerTurns":4,"repeatedReviewRounds":0,"repeatedExecuteAttempts":0,"repeatedValidateAttempts":2},"g3":{"mainInputTokens":22358617,"mainOutputTokens":58921,"runnerInputTokens":185207,"runnerOutputTokens":5023,"peakInputPerTurn":5381055,"medianInputPerTurn":-128675}}
- Historical JSON: [run-20260930004635-bc76d6a3.json](run-20260930004635-bc76d6a3.json)

## Case evidence

- A: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":3,"VALIDATE_SLICE":3,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":1,"applyFindings":0},"slice-03":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 12/12, runner 8/8.
- B: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":2,"VALIDATE_SLICE":4,"APPLY_FINDINGS":2,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":2,"applyFindings":2},"slice-02":{"execute":1,"validate":2,"applyFindings":0}}; telemetry coverage main 14/14, runner 11/11.
- C: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":3,"VALIDATE_SLICE":3,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":1,"applyFindings":0},"slice-03":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 12/12, runner 6/6.
