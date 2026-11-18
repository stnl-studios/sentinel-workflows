# Sentinel todo benchmark measurement

- Run: run-20261006173440-90810075
- Status: PASS; mode: full; profile: production-v3
- Time: 2026-10-06T17:34:41.126Z → 2026-10-06T18:44:58.744Z
- HEAD: ddce03bd20be8999a2c5571152ebb4766f4a9f32; dirty: false; functional diff: sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
- Source identity: sha256:8ce247fb58a09d20fc7de551939851db4ff60c23ba606cf2b3cedbfe2d89c1b1; snapshot: sha256:809d326464f3af6bcff45be8f62b8957891d45f295b288c8e613f80bafecc274
- Snapshot created: 2026-10-06T17:34:41.111Z

| Case | State | Blocker | Finalizer | Final tests | Spec closed | Official state | Operations | Main / runner turns | Duration ms | Slices |
|---|---|---|---|---|---|---|---:|---:|---:|---|
| A | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 12 | 12 / 6 | 2220219 | 3 |
| B | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 10 | 10 / 5 | 1549247 | 1 |
| C | PASS | unavailable | PASS (exit 0) | true | true | COMPLETE | 12 | 12 / 7 | 1996122 | 3 |

## Measured totals

- Operations: 34; recovery operations: 1; happy path operations: 33
- Main turns: 34; runner turns: 18; extra runner turns: 2
- Repeated reviews: 0; repeated execute/validate: 0 / 1
- Duration total / summed cases (ms): 4217618 / 5765588
- Telemetry coverage main / runner: 34/34 / 18/18
- main tokens (input/output/cached input/reasoning output): 16598946 / 198888 / 15059328 / 45504
- main observed input/output tokens: 16598946 / 198888
- runner tokens (input/output/cached input/reasoning output): 2356180 / 25508 / 1854464 / 1539
- runner observed input/output tokens: 2356180 / 25508
- Cached input and reasoning output are subcategories, not additional tokens. Input per turn is a context-pressure proxy, not measured window occupancy or billing.

## Comparison

- Reason: resultSchemaHash, qualification, profile
- Deltas versus baseline-v1: unavailable
- Historical JSON: [run-20261006173440-90810075.json](run-20261006173440-90810075.json)

## Case evidence

- A: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":3,"VALIDATE_SLICE":3,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":1,"applyFindings":0},"slice-03":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 12/12, runner 6/6.
- B: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":1,"VALIDATE_SLICE":2,"APPLY_FINDINGS":1,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":2,"applyFindings":1}}; telemetry coverage main 10/10, runner 5/5.
- C: PASS; blocker unavailable; terminal PASS; blocking operation "unavailable"; finalizer PASS; final tests true (node --test, exit 0); operations {"EXECUTE_SLICE":3,"VALIDATE_SLICE":3,"APPLY_FINDINGS":0,"REPLAN":0,"SPEC_RESUME":0,"REVIEW_PLAN":1,"REVIEW_TASKS":1}; slices {"slice-01":{"execute":1,"validate":1,"applyFindings":0},"slice-02":{"execute":1,"validate":1,"applyFindings":0},"slice-03":{"execute":1,"validate":1,"applyFindings":0}}; telemetry coverage main 12/12, runner 7/7.
