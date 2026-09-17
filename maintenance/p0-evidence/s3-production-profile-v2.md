# S3 Production Profile v2

## Status

`PRODUCTION_PROFILE_V2_READY`

This is a config-only checkpoint. No Production Pilot, Case A/B/C preparation,
qualification, live model call, or Luna probe was executed in this session.

## Base

- branch: `feature/atlas-p0`
- HEAD: `8d9e35d4e3e1d0e6aeab53cd2511ec2d4f639b6d`
- parent: `9972a4534cf7c80a9923fd66570a9504a2a3facf`
- initial working tree: clean, with no relevant untracked files
- parent-to-HEAD scope: Agent Harness Qualification v1 evidence/bookkeeping only
- Environment v1: READY
- Agent Harness v1: READY

## Trigger

SPEC Qualification Case A v2, published in
`s3-spec-qualification-case-a-v2.md`.

## Decision

The current manifest profile is `production-v2`. Case A SPEC uses
`GPT-5.6-Sol / high`.

This is a profile decision to reduce a known Terra variance before the E2E
Pilot. It is not a general model-quality or model-superiority conclusion.

## Rationale

- Terra is qualified for Case A SPEC, but variance was observed: Pilot #3 was
  draft/BLOCKED and Qualification v2 was READY.
- Sol/high was READY, preserved 11/11 explicit authorities, derived concrete
  oracles from the frozen baseline, and introduced no product invention.
- No negative Sol variance was observed through this checkpoint.

## Profile delta

| Definition | production-v1 | production-v2 |
| --- | --- | --- |
| Profile ID | `production-v1` | `production-v2` |
| Case A SPEC | GPT-5.6-Terra / high | GPT-5.6-Sol / high |

Exact semantic delta:

`A.SPEC: Terra/high -> Sol/high`

No other model/effort assignment changed.

## Preserved

- Case A PLAN/TASKS: Terra/high; EXECUTE/REVIEW_VALIDATE: Luna/high.
- Case B: Terra/high for SPEC/PLAN/TASKS; Luna/xhigh for EXECUTE and
  REVIEW_VALIDATE.
- Case C: Sol/high for SPEC/PLAN; Terra/high for TASKS; Luna/xhigh for
  EXECUTE and REVIEW_VALIDATE.
- A/B/C budgets, requirements hashes, fixture hashes, seed hash, benchmark
  version, result schema version, journal schema version, Cases, seed behavior,
  collector semantics, execution runtime, lifecycle runtime, skills, agents,
  templates, and integrations.
- Environment and Agent Harness contracts remain unchanged.
- `OFFICIAL_E2E_BASELINE` remains not established.

## Schema and runtime compatibility

The previous journal/result schemas hardcoded `production-v1`. The minimum
necessary compatibility update changes those fields to accept the historical
`production-v1` and current `production-v2` IDs. The runtime still requires
the manifest's current profile to be `production-v2`, reads expected dispatches
from that manifest, records `profileMismatches`, and has no fallback or
Case-specific model special case.

The comparator continues to reject results with different profile IDs, so raw
v1 results are not compared automatically with v2 results.

## Backlog hygiene

The Sol qualification arm left `.spec-init-candidate-benchmark-case-a` as
external residue. It did not alter the published SPEC, GLOBAL READY, or the
other arm and did not block qualification. It is classified as
`BACKLOG_HYGIENE`, not addressed here, and will become a concrete blocker only
if it causes a real Production Pilot effect.

## Tests

| Check | Result |
| --- | --- |
| P01 current profile ID = `production-v2` | PASS |
| P02 Case A SPEC = Sol/high | PASS |
| P03 remaining Case A phases preserved | PASS |
| P04 Case B unchanged | PASS |
| P05 Case C unchanged | PASS |
| P06 budgets unchanged | PASS |
| P07 Case/requirements/fixture hashes unchanged | PASS |
| P08 seed hash unchanged | PASS |
| P09 Sol/high Case A SPEC dispatch vs v2 produces zero mismatches | PASS |
| P10 Terra/high Case A SPEC dispatch vs v2 produces a mismatch | PASS |
| Environment deterministic tests | PASS |
| Agent Harness deterministic tests | PASS |

All checks use deterministic fixtures/mocks. No provider was called.

## Historical raw integrity

| Pilot | SHA-256 before | SHA-256 after | Identity |
| --- | --- | --- | --- |
| #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | same | byte-identical |
| #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | same | byte-identical |
| #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | same | byte-identical |

No raw Pilot result was rewritten.

## P0 ledger

- G1 = PROVEN
- G2 = PARTIAL
- G3 = PARTIAL
- G4 = PROVEN
- G5 = PROVEN
- G6 = NOT_YET_PROVEN

Profile v2 promotes no gate. `P0_COMPLETE` is not declared.

## Reviewer

Read-only review using GPT-5.6-Sol/high inputs: PASS.

The review confirmed the v1 historical profile, the v2 current profile, the
single semantic delta, preserved A/B/C assignments and budgets, unchanged
hashes/seed/environment/harness, required schema compatibility, deterministic
zero-mismatch Sol dispatch, enforced Terra mismatch, and preserved raw v1
results. It found no blocker and no basis for additional hardening before the
next Pilot.

## Next

Production Pilot #4 A -> B -> C against the next published checkpoint, using
`production-v2` without overrides and requiring `profileMismatches=[]` in all
three Cases. Do not execute it in this session.

## Resulting commit

`pending user commit`

Suggested title:

```text
chore(benchmark): adopt production profile v2
```
