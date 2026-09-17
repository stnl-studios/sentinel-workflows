# S3 Case A SPEC Qualification v2

## Status

`SPEC_QUALIFICATION_PASS`

The experiment was valid and conclusive. Both producer arms created a
structurally valid, globally ready Case A SPEC without invented product
authority. The run stopped after INIT, GLOBAL READINESS, and the single
independent meta-review.

Supported classifications:

- `TERRA_QUALIFIED_FOR_CASE_A_SPEC`
- `SOL_QUALIFIED_FOR_CASE_A_SPEC`
- `TERRA_CAPABLE_BUT_VARIANCE_OBSERVED`

No `MODEL_RESULTS_DIVERGED` classification is needed: the documentary outputs
differ, but both reach the same legitimate qualification result and the
difference has a simple factual interpretation.

## Base

- branch: `feature/atlas-p0`
- HEAD: `9972a4534cf7c80a9923fd66570a9504a2a3facf`
- parent: `6a7939b2f5b8ffee24223182c61cebf3a16d7236`
- commit: `feat(benchmark): qualify agent harness`
- initial working tree: clean, with no relevant untracked files
- parent-to-HEAD scope: Benchmark Agent Harness Qualification v1
- Environment Qualification v1: present and unchanged
- Agent Harness Qualification v1: present and unchanged
- Cases, Production Profile, budgets, requirements, and seed: verified at the
  frozen candidate

## Preconditions

| Precondition | Result |
| --- | --- |
| benchmark `verify` | PASS |
| seed tests | 8/8 PASS |
| benchmark contracts | 8/8 PASS |
| environment deterministic tests | 5/5 PASS |
| agent harness deterministic tests | 20 top-level / 24 total PASS |
| execution contracts sanity | 93/93 PASS |
| initial `git diff --check` | PASS |
| Environment doctor | `ENVIRONMENT_READY` |
| Harness check | `HARNESS_COMPLETED` |
| Harness capability fingerprint | contract 1; `codex-cli 0.154.0`; `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441` |
| Luna environment probe | `HARNESS_COMPLETED`; semantic PASS; one command exit 0; zero retry |

The one-shot probe requested GPT-5.6-Luna/medium with `workspace-write`. It ran
in a neutral seed-only disposable workspace and confirmed the correct CWD,
inherited managed TMPDIR, canonical `os.tmpdir()`, `node --test`, `mkdtemp`,
write/read, rename/remove, and final clean Git state. All probe facts passed and
`unexpectedEffects` was `none`.

Provider-reported model was unavailable and was not inferred.

Actual token telemetry: unavailable.

## Controls

| Control | Terra | Sol |
| --- | --- | --- |
| candidate SHA | `9972a4534cf7c80a9923fd66570a9504a2a3facf` | same |
| Case | A | A |
| fixture hash | `sha256:e0c3233c14356e93accff61b334704a91fb8e4f82a60209768259144d88a10d5` | same |
| requirements hash | `sha256:e5934bc22267756c3c10b31c46b7a9cd894b78e961b11975b0f14f7085349a24` | same |
| seed hash | `sha256:9d93fbfa52b2e20607452f43d0ecb21e74f1872bb7a2da1b94dc2c814e7552e8` | same |
| benchmark version | 1 | 1 |
| lifecycle skill | `stnl-spec-lifecycle-manager` | same |
| INIT mode and prompt shape | normal `MODE=INIT` | same |
| SPEC path pattern | `specs/benchmark-case-a` | same |
| producer model | GPT-5.6-Terra | GPT-5.6-Sol |
| producer effort | high | high |
| producer sandbox | `workspace-write` | same |
| readiness model / effort | GPT-5.6-Luna / high | same |
| readiness mode / scope | `READINESS` / `GLOBAL` | same |
| readiness sandbox | `workspace-write` | same |
| environment / harness contract | v1 / v1 | same |
| capability fingerprint | `a35d6560…e60441` | same |
| seed tests after prepare | 8/8 PASS | 8/8 PASS |
| historical hints supplied | none | none |
| retries / RESUME / correction | 0 / 0 / 0 | 0 / 0 / 0 |

The arms ran serially, Terra then Sol. Sol received no Terra artifact, result,
finding, history, or expected conclusion. The only experimental variable was
the SPEC producer model.

## Terra/high

### Harness facts

- status: `HARNESS_COMPLETED`
- requested model / effort / sandbox: GPT-5.6-Terra / high /
  `workspace-write`
- provider invocation accepted: yes
- session started / turn started / terminal: yes / yes / yes
- structured output parsed: yes
- provider-reported model: unavailable
- provider commands: 9, all exit 0
- retry count: 0

### INIT

- lifecycle state: `ready`
- target workspace: created
- manual correction: none
- RESUME: not run
- unrelated workspace output: none beyond the lifecycle lock and published
  SPEC artifacts

### Structural validation

The official lifecycle validator returned PASS with status `ready` and 11
canonical IDs.

Published artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `feature_spec.md` | `5a5e2e2484a463336c0d33a51f79dab3323b0c7ee1889f59c80f6f78a8d6c32a` |
| `shared/requirements.md` | `6a5eb7a83493a92c941a2b1b919b49fce7c53caf054e82abfa94e7bc40615c9b` |
| `shared/acceptance-criteria.md` | `09e96f401ac95589b6b94baa36e211031fa7c35e79a4ad89a07cc569f089c3b7` |

### GLOBAL READINESS

- harness: `HARNESS_COMPLETED`
- requested reviewer: GPT-5.6-Luna/high
- verdict: `READY`
- structural validation: PASS
- provider commands: 13, all exit 0
- retry count: 0
- published SPEC hashes before/after: identical

The qualification rubric records lower baseline-oracle specificity than Sol:
Terra generally preserves current behavior by reference instead of persisting
the concrete frozen-seed values. The independent meta-review concluded that
these comparisons remain observable against the frozen baseline and therefore
do not invalidate READY.

### Documentary metrics

| Metric | Value |
| --- | ---: |
| `feature_spec.md` bytes | 3,448 |
| `feature_spec.md` words | 508 |
| shared records | 11 |
| total SPEC bytes | 7,935 |
| total SPEC words | 1,161 |
| requirements | 5 |
| acceptance criteria | 6 |
| decisions | 0 |
| constraints | 0 |
| risks | 0 |
| open questions | 0 |

### Explicit authority

| Case A authority | Classification | SPEC evidence |
| --- | --- | --- |
| normal `list` | `PRESERVED` | R-001 / AC-001 |
| `list --completed` | `PRESERVED` | R-002 / AC-002 |
| `list --pending` | `PRESERVED` | R-002 / AC-003 |
| relative ordering | `PRESERVED` | R-002 / AC-002, AC-003 |
| one JSON object per line | `PRESERVED` | R-001, R-002 / AC-001–AC-003 |
| zero match: empty stdout, exit 0 | `PRESERVED` | R-003 / AC-004 |
| list variants read-only | `PRESERVED` | R-005 / AC-006 |
| mutually exclusive flags error tuple | `PRESERVED` | R-004 / AC-005 |
| unknown flags preserve usage-error contract | `PRESERVED` | R-004 / AC-005 |
| `add` compatibility | `PRESERVED` | R-005 / AC-006 |
| `complete` compatibility | `PRESERVED` | R-005 / AC-006 |

### Baseline derivation

| Baseline detail | Classification |
| --- | --- |
| exact `--store <path>` CLI shape | `NOT_DERIVED` |
| normal-list exit 0, empty stderr, ascending-id oracle | `NOT_DERIVED` beyond preservation by comparison |
| concrete unknown-flag tuple | `NOT_DERIVED` beyond preservation by comparison |
| validation/runtime failure exit 1 | `NOT_DERIVED` |
| Todo fields and new-item `completed=false` | `NOT_DERIVED` as a concrete compatibility oracle |
| concrete `add` / `complete` outcomes | `NOT_DERIVED` beyond the explicitly preserved dimensions |

No incorporated Terra detail was unsupported by the seed.

### Invention

`NONE`

Terra introduced no normative behavior outside Case A requirements, frozen
baseline preservation, or a technical statement needed to keep the oracle
observable.

### Finding classification

- `B — BASELINE_ORACLE_NOT_DERIVED`: the SPEC did not materialize several
  concrete seed values, although it retained observable preservation-by-
  comparison wording.
- no A, C, D, or published-SPEC E finding;
- the independent reviewer treated the Terra GLOBAL READY verdict as
  semantically valid despite the non-blocking B specificity finding.

## Sol/high

### Harness facts

- status: `HARNESS_COMPLETED`
- requested model / effort / sandbox: GPT-5.6-Sol / high /
  `workspace-write`
- provider invocation accepted: yes
- session started / turn started / terminal: yes / yes / yes
- structured output parsed: yes
- provider-reported model: unavailable
- provider commands: 12, all exit 0
- retry count: 0

### INIT

- lifecycle state: `ready`
- target workspace: created
- manual correction: none
- RESUME: not run
- producer residue: an untracked `.spec-init-candidate-benchmark-case-a`
  remained outside the published SPEC; it was not corrected or supplied to
  another arm

### Structural validation

The official lifecycle validator returned PASS with status `ready` and 16
canonical IDs.

Published artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `feature_spec.md` | `161fbe713a0a7cf6e9266db6a6a831ccf190f2ab06c82ca51d78e308e9042e0e` |
| `shared/requirements.md` | `80e939128483897a32cd402aad0ae61be913b23eeb0aff8a549de9f2d0dfed61` |
| `shared/acceptance-criteria.md` | `ea3e79da4459a7c0377d1b1fddd923976408ebd4ab8161e55bd5f4481e9c5505` |

### GLOBAL READINESS

- harness: `HARNESS_COMPLETED`
- requested reviewer: GPT-5.6-Luna/high
- verdict: `READY`
- structural validation: PASS
- provider commands: 9, all exit 0
- retry count: 0
- published SPEC hashes before/after: identical

### Documentary metrics

| Metric | Value |
| --- | ---: |
| `feature_spec.md` bytes | 3,959 |
| `feature_spec.md` words | 581 |
| shared records | 16 |
| total SPEC bytes | 9,519 |
| total SPEC words | 1,403 |
| requirements | 8 |
| acceptance criteria | 8 |
| decisions | 0 |
| constraints | 0 |
| risks | 0 |
| open questions | 0 |

### Explicit authority

| Case A authority | Classification | SPEC evidence |
| --- | --- | --- |
| normal `list` | `PRESERVED` | R-001 / AC-001 |
| `list --completed` | `PRESERVED` | R-002 / AC-002 |
| `list --pending` | `PRESERVED` | R-003 / AC-003 |
| relative ordering | `PRESERVED` | R-004 / AC-002, AC-003 |
| one JSON object per line | `PRESERVED` | R-001, R-004 / AC-001–AC-003 |
| zero match: empty stdout, exit 0 | `PRESERVED` | R-004 / AC-004 |
| list variants read-only | `PRESERVED` | R-005 / AC-005 |
| mutually exclusive flags error tuple | `PRESERVED` | R-005, R-006 / AC-006 |
| unknown flags preserve usage-error contract | `PRESERVED` | R-005, R-007 / AC-007 |
| `add` compatibility | `PRESERVED` | R-008 / AC-008 |
| `complete` compatibility | `PRESERVED` | R-008 / AC-008 |

### Baseline derivation

| Baseline detail | Classification | Seed evidence |
| --- | --- | --- |
| `--store <path>` and command shape | `SUPPORTED_BY_SEED` | CLI usage and argument parsing |
| list exit 0, empty stderr, ascending-id order | `SUPPORTED_BY_SEED` | CLI, store sort, CLI/store tests |
| usage error exit 2 / stderr / empty stdout | `SUPPORTED_BY_SEED` | CLI invalid-invocation path and CLI test |
| validation/runtime failure exit 1 | `SUPPORTED_BY_SEED` | CLI catch path |
| Todo fields and new item `completed=false` | `SUPPORTED_BY_SEED` | service and validation code/tests |
| persisted object containing only `todos` | `SUPPORTED_BY_SEED` | store read/write contract and tests |
| concrete `add` and `complete` outcomes | `SUPPORTED_BY_SEED` | service implementation and tests |

These details are `BASELINE_BEHAVIOR_DERIVATION`, not product invention. No
incorporated Sol detail was unsupported by the seed.

### Invention

`NONE`

### Finding classification

- `E — STRUCTURAL`: the producer left a candidate directory outside the
  published lifecycle workspace. This is workspace residue, not malformed
  published SPEC authority, and did not affect the validator or readiness
  result.
- no A, B, C, or D finding;
- classifying the seed-derived Sol details as invention would be
  `F — REVIEWER_FALSE_POSITIVE`.

## Direct comparison

| Dimension | Terra | Sol |
| --- | --- | --- |
| Harness completed | yes | yes |
| INIT state | ready | ready |
| Structural validator | PASS, 11 IDs | PASS, 16 IDs |
| GLOBAL READINESS | READY | READY |
| Explicit authority omissions | 0 | 0 |
| Baseline oracle omissions | concrete values not materialized; preservation by comparison retained | 0 material omissions found |
| Requirement gaps | 0 | 0 |
| Invented authority | none | none |
| Structural findings | none in published SPEC | external candidate residue |
| `feature_spec.md` bytes / words | 3,448 / 508 | 3,959 / 581 |
| total SPEC bytes / words | 7,935 / 1,161 | 9,519 / 1,403 |
| Shared records | 11 | 16 |

No quality score or winner is assigned.

## Meta-review

The single fresh GPT-5.6-Sol/high read-only meta-review completed through
Harness v1 with the same capability fingerprint and returned:

`PASS`

One preceding local PTY transport attempt exceeded the terminal input buffer
before harness request parsing and before any provider process or model session
started. The unchanged prompt was then transported through a managed temporary
file, and the actual meta-review was invoked exactly once. This was not a model
retry and contributed no model evidence.

It found no comparability or evidence blocker, confirmed all 11 explicit-
authority checklist items in both arms, found no requirement gap or product
invention, accepted both GLOBAL READY verdicts as semantically valid, and
classified `--store <path>` as seed-supported baseline derivation. No second
reviewer or hardening round was opened.

The meta-review also bounded unsupported conclusions: provider-reported model,
token parity, generalized model quality, implementation correctness, and a
comparative winner are not established.

## Qualification

- `TERRA_QUALIFIED_FOR_CASE_A_SPEC`
- `SOL_QUALIFIED_FOR_CASE_A_SPEC`
- `TERRA_CAPABLE_BUT_VARIANCE_OBSERVED`

Terra's current READY result proves capacity for this Case at this checkpoint.
Pilot #3 stopped a Terra/high SPEC as draft/BLOCKED, while this run reached a
legitimate READY result under the same requirements hash and fixture hash.
That is direct variance evidence. The persisted Pilot #3 record does not retain
enough raw SPEC content to isolate producer variance from readiness-reviewer
variance, so no narrower causal claim is made.

## Requirement boundary

`CASE_A_REQUIREMENTS_SUFFICIENT`

The source explicitly contains the filtering and compatibility authority. When
it requests preservation of current behavior, the frozen seed supplies the
observable CLI, `--store`, usage, exit, output, ordering, and persistence
details. No `REQUIREMENT_GAP` is supported.

## Production implication

Both Terra/high and Sol/high are qualified for Case A SPEC; Terra variance was
observed. The qualification does not select a winner or execute a Production
Pilot.

## Infrastructure attribution

| Question | Answer |
| --- | --- |
| environment issue | no |
| harness issue | no |
| model evidence valid | yes |

## Historical integrity

| Raw result | Before SHA-256 | After SHA-256 | Identity |
| --- | --- | --- | --- |
| Pilot #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| Pilot #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| Pilot #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |

The earlier blocked qualification remains
`SPEC_QUALIFICATION_BLOCKED_ENVIRONMENT`; it was not replaced or recalculated.

## Persisted files

- `maintenance/p0-evidence/s3-spec-qualification-case-a-v2.md`
- `maintenance/p0-evidence/s3-benchmark-agent-harness-v1.md`
- `maintenance/p0-evidence/checkpoints.md`
- `maintenance/p0-evidence/README.md`

No temporary workspace, provider JSONL, credential, transcript, or chain-of-
thought was persisted.

## Final checks

| Command | Exit | Result |
| --- | ---: | --- |
| `git diff --check` | 0 | PASS |
| `node benchmarks/sentinel-todo/runtime/benchmark.mjs verify` | 0 | PASS |
| `node --test benchmarks/sentinel-todo/seed/test/*.test.mjs` | 0 | 8/8 PASS |
| `node scripts/test-benchmark-contract.mjs` | 0 | 8/8 PASS |
| `node scripts/test-benchmark-environment.mjs` | 0 | 5/5 PASS |
| `node scripts/test-benchmark-agent-harness.mjs` | 0 | 20 top-level / 24 total PASS |
| `node --test scripts/test-execution-contract.mjs` | 0 | 93/93 PASS |
| `node --test scripts/test-repository-contract.mjs` | 0 | 3/3 PASS |
| `bash scripts/validate.sh --no-smoke` | 0 | PASS |

No live model operation or Luna probe was rerun during final checks.

## P0

- G1 = PROVEN
- G2 = PARTIAL
- G3 = PARTIAL
- G4 = PROVEN
- G5 = PROVEN
- G6 = NOT_YET_PROVEN

No gate was promoted or reopened. `P0_COMPLETE` and an official E2E baseline
remain unestablished.

## Next step

`selecionar explicitamente o SPEC model do próximo Pilot com base na estabilidade observada, sem nova qualification.`

Do not start it automatically.

## Resulting commit

`8d9e35d4e3e1d0e6aeab53cd2511ec2d4f639b6d`

Suggested commit:

```text
docs(benchmark): record Case A SPEC requalification

- compare Terra/high and Sol/high under qualified environment and harness controls
- classify authority preservation, baseline derivation and readiness outcomes
- record both Case A SPEC producers as qualified, with Terra variance observed
```
