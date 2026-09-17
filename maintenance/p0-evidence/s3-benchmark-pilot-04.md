# S3 Production Benchmark Pilot 04

## Status

`PRODUCTION_PILOT_04_BLOCKED_CASE_A`

Case A stopped in `AUXILIARY_BLOCKED` after the three state-authorized
`EXECUTE_SLICE` attempts for `slice-01`. The canary gate did not pass, so Cases
B and C were not prepared or executed. No correction was attempted during the
Pilot.

## Candidate

- branch: `feature/atlas-p0`
- candidate: `03724a7f646d6d20f57b7cb85ea6358bdf29c999`
- parent: `8d9e35d4e3e1d0e6aeab53cd2511ec2d4f639b6d`
- initial tree: `bf6bb08d80e9ad3120a399ad6c0e2b02cd637ae9`
- commit: `chore(benchmark): adopt production profile v2`
- published branch HEAD: confirmed
- initial working tree: clean, with no relevant untracked files

## Profile

`production-v2`

| Case | SPEC | PLAN | TASKS | EXECUTE | REVIEW / VALIDATE |
| --- | --- | --- | --- | --- | --- |
| A | Sol/high | Terra/high | Terra/high | Luna/high | Luna/high |
| B | Terra/high | Terra/high | Terra/high | Luna/xhigh | Luna/xhigh |
| C | Sol/high | Sol/high | Terra/high | Luna/xhigh | Luna/xhigh |

No override or fallback was used.

## Preconditions

| Check | Result |
| --- | --- |
| branch / HEAD / parent / published HEAD | PASS |
| clean source checkout / `git diff --check` | PASS |
| benchmark authority = `production-v2` | PASS |
| benchmark verify | PASS |
| seed tests | 8/8 PASS |
| benchmark contracts | 9/9 PASS |
| environment deterministic tests | 5/5 PASS |
| Agent Harness deterministic tests | 24/24 PASS |
| execution contracts | 93/93 PASS |
| launcher contracts | 83/83 PASS |
| repository contracts | 3/3 PASS |
| `validate.sh --no-smoke` | PASS |
| Environment Doctor v1 | `ENVIRONMENT_READY` |
| Agent Harness v1 | `HARNESS_COMPLETED` |
| provider / contract | Codex / 1 |
| provider version | `codex-cli 0.154.0` |
| capability fingerprint | `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441` |
| one-shot Luna/medium probe | `HARNESS_COMPLETED`; semantic PASS; one command; zero retry |

The one-shot probe confirmed the workspace, inherited managed TMPDIR, canonical
`os.tmpdir()`, `mkdtemp`, write/read, rename/remove, `node --test`, clean Git,
structured output, and cleanup of its child temp path. It was not repeated.

## Canary Case A

### Identity and preparation

- seed hash: `sha256:9d93fbfa52b2e20607452f43d0ecb21e74f1872bb7a2da1b94dc2c814e7552e8`
- requirements hash: `sha256:e5934bc22267756c3c10b31c46b7a9cd894b78e961b11975b0f14f7085349a24`
- fixture hash: `sha256:e0c3233c14356e93accff61b334704a91fb8e4f82a60209768259144d88a10d5`
- prepared tests: PASS
- prepared local Git tree: clean
- target SPEC: absent before INIT
- candidate residue after INIT: none observed

### Sequence

| Event | Operation | Result | Resulting state |
| ---: | --- | --- | --- |
| 1 | SPEC_INIT | PASS | `ready` |
| 2 | PLAN | PASS | `PLANNED_DRAFT` |
| 3 | REVIEW_PLAN | PASS | `PLANNED_READY` |
| 4 | MATERIALIZE_TASKS | PASS | `MATERIALIZED_PRISTINE` |
| 5 | REVIEW_TASKS | PASS | `MATERIALIZED_PRISTINE` |
| 6 | EXECUTE_SLICE slice-01 | BLOCKED | `AUXILIARY_BLOCKED` |
| 7 | EXECUTE_SLICE slice-01 | BLOCKED | `AUXILIARY_BLOCKED` |
| 8 | EXECUTE_SLICE slice-01 | BLOCKED | `AUXILIARY_BLOCKED` |

The first runner result created `implementation-check-01` and returned the
deterministic mandatory same-operation recovery for `EXECUTE_SLICE / slice-01`.
The two later calls followed that persisted target and created
`implementation-check-02` and `implementation-check-03`. Each runner reported
that the declared requirements authority
`sha256:94e4171ce346998986aa883307127fec46bc8284fb71988ffeddf241fbf5a6ab`
diverged from its derived raw `shared/requirements.md` hash
`sha256:042223cf19d59d7549d5d2ae6865569d086dc1bacdc0da8f378ba2d0a5c0465b`.
No verification command ran in those child sessions. The third attempt consumed
the frozen per-slice EXECUTE limit, so no fourth operation was started.

### Structure and metrics

| Fact | Value |
| --- | ---: |
| slices | 3 |
| tasks | 9 |
| tasks per slice | 3 / 3 / 3 |
| total workflow events | 8 |
| PLAN reviews | 1 |
| TASK reviews | 1 |
| REPLAN | 0 |
| EXECUTE calls | 3 |
| VALIDATE calls | 0 |
| APPLY_FINDINGS calls | 0 |
| findings cycles | 0 |
| external Harness retries | 0 |
| mechanical rejections recorded | 4 |
| changed files | 15 |
| final diff bytes | 37,584 |

### Models and child dispatches

| Phase | Expected | Requested | Match |
| --- | --- | --- | --- |
| SPEC | Sol/high | Sol/high | yes |
| PLAN | Terra/high | Terra/high | yes |
| TASKS | Terra/high | Terra/high | yes |
| EXECUTE | Luna/high | Luna/high | yes |
| REVIEW_VALIDATE | Luna/high | Luna/high | yes |

All three EXECUTE events recorded one `stnl_validation_runner` child dispatch
at Luna/medium. Provider-reported model was unavailable and was not inferred.

`profileMismatches=[]`

### Budgets

| Budget | Used | Max | Result |
| --- | ---: | ---: | --- |
| workflow events | 8 | 14 | within limit |
| REVIEW_PLAN | 1 | 2 | within limit |
| REVIEW_TASKS | 1 | 2 | within limit |
| REPLAN | 0 | 1 | within limit |
| EXECUTE attempts, slice-01 | 3 | 3 | limit reached |
| APPLY_FINDINGS, slice-01 | 0 | 2 | within limit |

The journal did not enter `ABORTED_BUDGET`. The branch stopped because its next
mandatory recovery would require a prohibited fourth EXECUTE attempt.

### Context proxies

| Proxy | Value |
| --- | ---: |
| PLAN bytes / words | 11,966 / 1,624 |
| TASKS bytes / words | 13,930 / 1,695 |
| child dispatch count | 3 |
| handoff bytes | unavailable |
| observable reads | unavailable |

Actual token telemetry: unavailable

No token estimate or token-savings claim is made.

### Terminal facts

| Fact | Result |
| --- | --- |
| Case status | `BLOCKED_SENTINEL` |
| final execution state | `AUXILIARY_BLOCKED` |
| COMPLETE | no |
| GLOBAL READY | not run |
| lifecycle CLOSED | no |
| collector final tests | PASS |
| collector raw status | `BLOCKED` |

Final tests passing does not promote the incomplete execution state.

## A gate

`CASE_A_CANARY_PASS` was not emitted.

Blocker:

- operation: `EXECUTE_SLICE`
- slice: `slice-01`
- category: Sentinel auxiliary-runner semantic blocker
- last valid state: `AUXILIARY_BLOCKED`
- persisted recovery record: `implementation-check-03`
- remaining legal state transition: same-operation `EXECUTE_SLICE / slice-01`
- Pilot action: stopped because 3/3 EXECUTE attempts were consumed

## Parallel authorization

`B_C_PARALLEL_AUTHORIZED` was not emitted.

## Case B

`NOT_RUN — canary gate failed`

No session root, workspace, journal, result, or model session was created.

## Case C

`NOT_RUN — canary gate failed`

No session root, workspace, journal, result, or model session was created.

## Parallel execution evidence

| Fact | B | C |
| --- | --- | --- |
| Authorized | no | no |
| First model session start | not applicable | not applicable |
| Terminal | `NOT_RUN` | `NOT_RUN` |
| Status | canary gate failed | canary gate failed |

Overlap was not observed or claimed because the parallel phase was never
authorized.

## Branch isolation

Case A and the reviewer used distinct OS-temp-derived canonical session roots,
workspaces, and runner-tmp directories. B/C roots were not created. The source
checkout remained clean throughout live execution. No Case artifact was passed
to another Case.

## Operational repetition

G2 remains `PARTIAL`.

The three EXECUTE events were not silent external retries: each followed the
same-operation recovery target persisted by the previous valid Sentinel state.
They remained within the frozen per-slice limit. There was no external Harness
retry, REPLAN, APPLY_FINDINGS, redundant readiness, or close. A/B/C did not all
PASS, so the promotion criteria are not met.

## Context pressure

G3 remains `PARTIAL`.

Deterministic PLAN/TASKS bytes and words, operation count, and child dispatch
count exist only for partial Case A. There is no actual token telemetry and no
A/B/C evidence set. No new threshold is introduced.

## Complete workflow

G6 remains `NOT_YET_PROVEN`. Case A did not reach COMPLETE, GLOBAL READY, or
CLOSE, and Cases B/C were not run.

## Raw results

Only the truthful partial A raw was persisted:

- `maintenance/benchmark-results/03724a7f646d6d20f57b7cb85ea6358bdf29c999/case-a-production-v2.json`
- SHA-256: `fa6b421fe4861a497f15f5432acfdb7f3b5d22e5e3c48780398181f6a794a202`
- copy verification: byte-identical before and after persistence

No B/C placeholder was created.

## Reviewer

The single required GPT-5.6-Sol/high read-only reviewer invocation returned
`HARNESS_INIT_FAILED` before session creation, with provider category
`PROVIDER_ERROR`, zero commands, and zero retry. No semantic reviewer verdict
is claimed and no second review was attempted.

This infrastructure failure is recorded as an additional Pilot blocker. It
does not change the earlier canary stop-loss classification or authorize B/C.

## Historical integrity

| Pilot | SHA-256 | Result |
| --- | --- | --- |
| #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |

## Baseline

`OFFICIAL_E2E_BASELINE = NOT_YET_ESTABLISHED`

## P0 ledger

| Gate | State |
| --- | --- |
| G1 | PROVEN |
| G2 | PARTIAL |
| G3 | PARTIAL |
| G4 | PROVEN |
| G5 | PROVEN |
| G6 | NOT_YET_PROVEN |

## P0

`P0_OPEN`

## Functional diff

During live execution the source checkout stayed clean. After the run, all
source-checkout changes are confined to `maintenance/p0-evidence/**` and
`maintenance/benchmark-results/**`.

## Cleanup

- Case A session root: removed
- reviewer session root: removed
- Case B/C session roots: not created
- owned temp residue: none

## Final checks

The live probe, Cases, and reviewer were not rerun.

| Check | Result |
| --- | --- |
| `git diff --check` | PASS |
| benchmark verify | PASS |
| seed tests | 8/8 PASS |
| benchmark contracts | 9/9 PASS |
| environment deterministic tests | 5/5 PASS |
| Agent Harness deterministic tests | 24/24 PASS |
| execution contracts | 93/93 PASS |
| launcher contracts | 83/83 PASS |
| repository contracts | 3/3 PASS |
| `validate.sh --no-smoke` | PASS |

## Resulting commit

`pending user commit`

Suggested title:

```text
docs(benchmark): record blocked Production Pilot #4
```
