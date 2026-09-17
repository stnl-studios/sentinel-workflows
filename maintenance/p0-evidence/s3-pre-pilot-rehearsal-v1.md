# S3 Pre-Pilot Rehearsal v1

## Status

`PRE_PILOT_REHEARSAL_BLOCKED`

## Base

`29b4d6f1979d8d2590260b4888cf15b696631961`

- branch: `feature/atlas-p0`
- parent: `03724a7f646d6d20f57b7cb85ea6358bdf29c999`
- initial working tree: clean, with no relevant untracked files
- published branch HEAD: confirmed on `origin/feature/atlas-p0`
- parent to HEAD: Pilot #4 evidence only
- Production Profile: `production-v2`
- Environment v1: READY
- Agent Harness v1: READY

## Pilot #4 blocker

Pilot #4 Case A declared canonical Requirements authority
`sha256:94e4171ce346998986aa883307127fec46bc8284fb71988ffeddf241fbf5a6ab`
but the validation runner independently hashed only `shared/requirements.md` as
`sha256:042223cf19d59d7549d5d2ae6865569d086dc1bacdc0da8f378ba2d0a5c0465b`.
It treated those different identities as stale authority, returned `BLOCKED`
three times, and left execution in `AUXILIARY_BLOCKED`.

## Root cause proof

The canonical lifecycle fixture used by R01 produced:

- raw `shared/requirements.md` SHA-256:
  `sha256:ea5e5510c2cb9a4385f72dcc43d0a81edb1f831f6413d384ce606c4b2fe78742`;
- official `computeRequirementsAuthority(SPEC_PATH)`:
  `sha256:2dc308b97aba26e170cb0759f155b9a1882afa86d6a1272b0284263037235df5`;
- comparison: different, as expected;
- execution plan and task authority: the official canonical value;
- official `EXECUTE_SLICE` preflight: `MATERIALIZED_PRISTINE`, same canonical
  value, `stale=false`.

They differ because lifecycle execution authority hashes the runtime-owned
canonical projection of the feature core plus canonical lifecycle records under
the `stnl-requirements-authority-v1` domain. A raw file hash identifies one
physical Markdown file only. `computeRequirementsAuthority(SPEC_PATH)`, exposed
through the official execution validator/preflight, is the sole owner of the
execution authority calculation.

R02 changed a canonical requirement record. The official authority changed,
inspection returned `REQUIREMENTS_CHANGED`, stale detection remained active,
and official preflight authorized `REPLAN`.

## Correction

| Paths | Semantic delta |
| --- | --- |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | Bump contract to v7; require official runtime authority readback; compare payload, artifacts, and runtime authority; forbid raw lifecycle file hashes and ad hoc fallback. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | Same v7 authority contract, byte-equivalent in semantics to Codex. |
| `templates/prompts/slice-*-codex.md`, `templates/prompts/slice-*-claude.md` | Include the applicable official execution validator/preflight in the minimal runner payload for EXECUTE, APPLY_FINDINGS, and VALIDATE. |
| `scripts/check-contracts.mjs`, `scripts/test-validation-runner-contract.mjs`, `scripts/test-launcher-contract.mjs` | Enforce official checker use and reject deliberate raw `shared/requirements.md` or `feature_spec.md` authority regressions. |
| `benchmarks/sentinel-todo/README.md` | Define valid runner `BLOCKED` as terminal for the current benchmark Case with zero automatic re-entry, while preserving later manual runtime recovery legality. |
| `benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs` | Add the temporary deterministic/live rehearsal driver, including canonical authority, drift, BLOCKED stop, live chain, reviewer, and parallel smoke stages. |
| `scripts/test-benchmark-rehearsal.mjs` | Add deterministic R01-R05 and BLOCKED/TESTS_FAIL orchestration regressions. |

No execution runtime algorithm, lifecycle model, artifact schema, benchmark
Case, seed, Production Profile, model assignment, or budget changed.

## Rehearsal stages

| Stage | Result | Evidence |
| --- | --- | --- |
| R01 | PASS | Raw shared SHA differs from canonical authority; plans/tasks and official preflight use canonical; no stale state. |
| R02 | PASS | Canonical record mutation changed authority and produced `REQUIREMENTS_CHANGED` with `REPLAN` recovery. |
| R03 | PASS | Codex/Claude v7 contracts accepted; deliberate raw shared-hash authority mutation rejected as `R019_REQUIREMENTS_AUTHORITY`. |
| R04 | PASS | Exactly one EXECUTE event and one implementation check; `AUXILIARY_BLOCKED`; terminal Case; zero automatic rounds/re-entry. |
| R05 | PASS | Temporary real fixture entered `MATERIALIZED_PRISTINE` through official inspection. |
| R06 | PASS | Final rehearsal run: Harness completed; runner returned `TESTS_PASS`; one implementation check; official state `IMPLEMENTED_AWAITING_VALIDATION`. |
| R07 | FAIL | Harness completed, but the started validation result was malformed; main persisted the canonical malformed-output delegation blocker and official state became `RUNNER_RESULT_BLOCKED`. |
| R08 | NOT_RUN | Dependent on R07 PASS. |
| R09 | NOT_RUN | Dependent on R08 PASS. |
| R10 | NOT_RUN | Dependent on R09 PASS. |
| R11 | NOT_RUN | Reviewer must run only after R10 PASS. |
| R12 | NOT_RUN | Parallel smoke must run only after R11 PASS. |
| R13 | NOT_RUN | Final suite must run only after all live checks pass. |

Failure category: `RUNNER_SEMANTIC`.

Objective blocker: the real `VALIDATE_SLICE` child session started but did not
return the strict formal validation schema. The main operation correctly
persisted `Kind: malformed-output` and stopped in `RUNNER_RESULT_BLOCKED`.

Last passing stage: `R06`.

## Remediation cycles

Two cycles were used, with objective advancement:

1. The initial R06 `HARNESS_INIT_FAILED` was traced to a non-Git temporary CWD.
   The fixture gained a local `git init` only, and implementation paths were
   placed in the temporary project root outside lifecycle ownership.
2. The next R06 used the globally installed runner v6 and reproduced the raw
   authority blocker. Without changing global configuration, the corrected v7
   adapter was projected into the temporary project's `.codex/agents`. The
   following run advanced through R06 with `TESTS_PASS` and failed later at R07.

No third remediation cycle or live retry was opened.

## Live model calls

| Purpose | Requested model | Effort | Status | Retry count |
| --- | --- | --- | --- | ---: |
| R06 initial geometry | GPT-5.6-Luna | high | `HARNESS_INIT_FAILED` | 0 |
| R06 after cycle 1 | GPT-5.6-Luna | high | `HARNESS_COMPLETED`; valid runner `BLOCKED`; `AUXILIARY_BLOCKED` | 0 |
| R06 after cycle 2 | GPT-5.6-Luna | high | `HARNESS_COMPLETED`; `TESTS_PASS`; `IMPLEMENTED_AWAITING_VALIDATION` | 0 |
| R07 validation | GPT-5.6-Luna | high | `HARNESS_COMPLETED`; malformed runner output; `RUNNER_RESULT_BLOCKED` | 0 |

Every cycle restarted from R01. No Production Pilot or Case A/B/C was run.

## Reviewer

`NOT_RUN — R07 failed`

## Parallel smoke

- start facts: not run;
- overlap: not claimed;
- isolation: not evaluated;
- cleanup: all created rehearsal session roots were independently removed.

## Historical raw integrity

| Pilot | SHA-256 | Result |
| --- | --- | --- |
| #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |
| #4 | `fa6b421fe4861a497f15f5432acfdb7f3b5d22e5e3c48780398181f6a794a202` | byte-identical |

## P0 ledger

INALTERADO:

- G1 PROVEN
- G2 PARTIAL
- G3 PARTIAL
- G4 PROVEN
- G5 PROVEN
- G6 NOT_YET_PROVEN

## Baseline

`OFFICIAL_E2E_BASELINE = NOT_YET_ESTABLISHED`

## Focused checks completed before the live blocker

| Check | Result |
| --- | --- |
| `git diff --check` | PASS |
| validation-runner contracts | 91/91 PASS |
| launcher contracts | 84/84 PASS |
| rehearsal deterministic contracts | 3/3 PASS |
| R01-R05 deterministic run | PASS |

The R13 final deterministic suite was intentionally not run because it is
downstream of R07-R12.

## Next

Resolve the reproducible R07 malformed validation-runner output under a new
authorized checkpoint, then rerun the rehearsal from R01. Do not execute a
Production Pilot from this blocked checkpoint.

## Resulting commit

`pending user commit`
