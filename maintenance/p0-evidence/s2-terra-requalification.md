# S2 Terra Requalification

## Candidate

`51af7df0d8e1abad319b514cfb548c121e571211`

## Producer

`GPT-5.6-Terra`

## Reviewer

`GPT-5.6-Sol / high`

## Previous Result

`S2_MODEL_QUALIFICATION_FAIL`

## Current Result

`S2_MODEL_REQUALIFICATION_PASS`

## Cases

| Case | Slices | Tasks | REVIEW_PLAN rounds | REVIEW_TASKS rounds | Mechanical rejections | PLAN bytes / words | TASKS bytes / words | Repetition | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| A | 1 | 1 | 1 | 1 | 1 | 5898 / 770 | 3962 / 514 | LOW | PASS |
| B | 3 | 3 | 1 | 1 | 0 | 12598 / 1441 | 9200 / 1102 | MODERATE | PASS |
| C | 2 | 6 | 1 | 1 | 1 | 13153 / 1552 | 8144 / 1000 | MODERATE | PASS |

Mechanical rejections count PLAN/TASKS candidate invocations, not INIT parent-directory setup. Case A's incomplete materialization candidate omitted the approved planning set; the runtime rejected it before publication and Terra corrected it in one attempt. Case C's live execution root was incorrectly supplied as a candidate during readback; the runtime rejected the invocation and Terra used the contracted readback in one attempt. Neither rejection was an implementation-path claim, and no invalid candidate was published.

Actual token telemetry: unavailable. Bytes and words are context-cost proxies.

## BF-A/B Comparison

- `BF-A-PATHS`: under the previous candidate, an invalid implementation path survived to `MATERIALIZED_PRISTINE`. Under the hardened candidate, Case A produced artifact-relative claims that passed deterministic validation on the first PLAN attempt; no invalid implementation path survived.
- `BF-B-PATHS`: under the previous candidate, an invalid implementation path survived to `MATERIALIZED_PRISTINE`. Under the hardened candidate, Case B produced artifact-relative claims that passed deterministic validation on the first PLAN and TASKS attempts; no invalid implementation path survived.
- The exact BF-A/B path errors were not reproduced in this run, so the observed qualification difference is non-production rather than an actual rejection of those two claims. The hardened runtime remained the mandatory pre-publication gate, accepted safe future targets, and provided no fallback path interpretation.

The prior blockers are eliminated from final artifacts. The path-semantics checkpoint independently records deterministic rejection coverage for execution-root, lifecycle-SPEC-local, path-basis, trusted-root escape, symlink, and non-canonical claims.

## Review and Quality

- All three cases reached `MATERIALIZED_PRISTINE` with executable final paths.
- Boundary coherence, scope fidelity, task executability, and PLAN-to-TASKS fidelity passed independent review.
- Every REVIEW_PLAN and REVIEW_TASKS gate converged in round 1.
- Case B retained justified repetition around its explicit regression slice.
- Case C's first PLAN was consolidated from three slices to two during REVIEW_PLAN, and one metadata microtask was merged during REVIEW_TASKS; both corrections completed in the first review round without REPLAN.
- Final independent comparative reviewer: `PASS`.
- No contract was relaxed for Terra.

## G5

`PROVEN`

GPT-5.6-Terra is qualified for PLAN/TASKS when used with the current contracts and deterministic guardrails.
