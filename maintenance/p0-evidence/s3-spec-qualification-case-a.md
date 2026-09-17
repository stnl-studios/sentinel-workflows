# S3 Case A SPEC Qualification — Terra vs Sol

## Status

`SPEC_QUALIFICATION_BLOCKED_ENVIRONMENT`

The qualification stopped before either SPEC producer ran. The required
one-shot Luna/medium sandbox probe did not start because the model harness
rejected its invocation options before creating an agent session. The probe was
not retried.

## Candidate

- branch: `feature/atlas-p0`
- HEAD: `eeac1c293147c1e14a50e71e8ac8e7b26d6a5ecd`
- parent: `2f4bf84e45d94e6b2bdb503edcbb2f8927e133de`
- commit: `feat(benchmark): qualify execution environment`
- initial working tree: clean, with no relevant untracked files
- parent-to-HEAD scope: Benchmark Environment Qualification v1 implementation,
  contracts, documentation, and evidence only
- benchmark Cases, Production Profile, budgets, requirements, seed, skills,
  agents, templates, and runtimes relevant to the lifecycle experiment:
  unchanged by the candidate delta except for the benchmark environment runtime
  and its documented routing

## Environment

### Deterministic precondition

| Check | Result |
| --- | --- |
| benchmark verify | PASS |
| seed tests | 8/8 PASS |
| benchmark contracts | 8/8 PASS |
| execution contracts sanity check | 93/93 PASS |
| environment doctor | `ENVIRONMENT_READY` |

The doctor emitted one sanitized JSON line with no blockers. Its stable
fingerprint was:

| Field | Value |
| --- | --- |
| environment contract version | 1 |
| platform | darwin |
| architecture | arm64 |
| Node | v22.20.0 |
| Git | 2.51.0 |
| benchmark version | 1 |
| doctor | PASS |

The session root was unique, outside the checkout, realpath-canonicalized, and
contained independent Terra and Sol workspace roots, an evidence area, and a
managed runner temp directory. No absolute session path is persisted here.

### Luna sandbox probe

| Field | Result |
| --- | --- |
| requested model | GPT-5.6-Luna |
| requested effort | medium |
| requested isolation | workspace-write |
| managed TMPDIR supplied to harness process | yes |
| model session started | no |
| probe operation started | no |
| harness result | init/transport failure |
| retry | none |

The harness rejected an unsupported invocation option with
`unexpected argument '-a'` before agent creation. Because the experiment
requires exactly one probe with no retry, this is an environment/harness
precondition failure rather than model evidence. The neutral seed-only probe
workspace remained clean.

## Experiment controls

The planned controls were fixed as follows, but comparability was not exercised
because the mandatory probe failed before either arm.

| Control | Terra arm | Sol arm |
| --- | --- | --- |
| candidate SHA | `eeac1c293147c1e14a50e71e8ac8e7b26d6a5ecd` | same |
| Case | A | A |
| requirements hash | `sha256:e5934bc22267756c3c10b31c46b7a9cd894b78e961b11975b0f14f7085349a24` | same |
| seed hash | `sha256:9d93fbfa52b2e20607452f43d0ecb21e74f1872bb7a2da1b94dc2c814e7552e8` | same |
| lifecycle skill | `stnl-spec-lifecycle-manager` | same |
| readiness model / effort | GPT-5.6-Luna / high | same |
| readiness scope | GLOBAL | GLOBAL |
| environment contract | Benchmark Environment Qualification v1 | same |
| variable | GPT-5.6-Terra / high SPEC producer | GPT-5.6-Sol / high SPEC producer |

## Terra

- prepare: not run
- SPEC_INIT: not run
- GLOBAL READINESS: not run
- documentary metrics: unavailable
- explicit authority preservation: not evaluated
- baseline behavior derivation: not evaluated
- product invention: not evaluated
- findings classification: not evaluated
- context scout: not used
- actual token telemetry: unavailable

## Sol

- prepare: not run
- SPEC_INIT: not run
- GLOBAL READINESS: not run
- documentary metrics: unavailable
- explicit authority preservation: not evaluated
- baseline behavior derivation: not evaluated
- product invention: not evaluated
- findings classification: not evaluated
- context scout: not used
- actual token telemetry: unavailable

## Comparison

| Dimension | Terra | Sol |
| --- | --- | --- |
| SPEC_INIT | not run | not run |
| GLOBAL READINESS | not run | not run |
| authority preservation | not evaluated | not evaluated |
| baseline derivation | not evaluated | not evaluated |
| invention | not evaluated | not evaluated |
| comparable model evidence | none | none |

## Reviewer

The independent meta-review was not run because no arm artifacts exist. A PASS
or BLOCKING_FINDING conclusion about model behavior would be unsupported.

## Qualification result

`SPEC_QUALIFICATION_BLOCKED_ENVIRONMENT`

No Terra or Sol qualification result is declared. The experiment did not reach
the point where `SPEC model` could be isolated or measured.

## Requirement boundary

Not evaluated. This blocked run provides no evidence that Case A is sufficient
or that it contains a genuine gap, and it provides no evidence of producer
omission or invented authority.

## Production implication

Do not select a Case A SPEC model from this run. Correct the harness invocation
outside this session and rerun the complete qualification from a fresh session,
starting with a new one-shot Luna/medium probe.

## P0 impact

- G1 = PROVEN
- G2 = PARTIAL
- G3 = PARTIAL
- G4 = PROVEN
- G5 = PROVEN
- G6 = NOT_YET_PROVEN

No gate is promoted or reopened. P0 remains incomplete.

## Historical integrity

| Raw result | SHA-256 | Identity |
| --- | --- | --- |
| Pilot #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| Pilot #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| Pilot #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |

No historical status was recalculated.

## Protocol integrity

- producer SPEC_INIT executions: 0
- GLOBAL READINESS executions: 0
- RESUME executions: 0
- retries: 0
- manual SPEC corrections: 0
- cross-arm context transfer: none
- PLAN or later lifecycle/execution operations: 0

The stop-loss was honored immediately after the failed mandatory probe.

## Final checks

No model operation was rerun during final validation.

| Check | Result |
| --- | --- |
| `git diff --check` | PASS |
| benchmark verify | PASS |
| environment doctor | `ENVIRONMENT_READY` |
| benchmark contracts | 8/8 PASS |
| environment deterministic tests | 4/4 PASS |
| `bash scripts/validate.sh --no-smoke` | PASS |

## Resulting commit

`6a7939b2f5b8ffee24223182c61cebf3a16d7236`
