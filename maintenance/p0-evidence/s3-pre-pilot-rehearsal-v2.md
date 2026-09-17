# S3 Pre-Pilot Rehearsal v2

## Status

`PRE_PILOT_REHEARSAL_BLOCKED`

## Base

`5d9ecc9b4aa143519948f020ab771f257d0186b0`

- branch: `feature/atlas-p0`
- parent: `29b4d6f1979d8d2590260b4888cf15b696631961`
- initial working tree: clean, with no relevant untracked files
- published branch HEAD: confirmed on `origin/feature/atlas-p0`
- parent to HEAD: canonical authority correction plus Pre-Pilot Rehearsal v1
- Production Profile: `production-v2`
- Environment v1: READY
- Agent Harness v1: READY

## Previous blocker

R07 malformed validation-runner output. The child session started, the main
session did not fabricate a Validation Attempt, and official state became
`RUNNER_RESULT_BLOCKED` with `Kind: malformed-output`.

## R07 forensic

The forensic phase used one fresh OS-temp workspace and no live R06 call. The
deterministic POST-R06 fixture was accepted by the official candidate validator
and `VALIDATE_SLICE` preflight as `IMPLEMENTED_AWAITING_VALIDATION`. It carried
one `TESTS_PASS` implementation check, revision 1, no attempt/base/finding/
divergence/blocker, an open global row, and a pending final result.

| Item | Result |
| --- | --- |
| pre-state | `IMPLEMENTED_AWAITING_VALIDATION` |
| child session started | yes; outer Harness and turn completed |
| expected schema | all `VALIDATE_SLICE` fields; exact complete commands and numeric exits |
| observed shape | all required fields present; `initial`; `PASS`; file-backed manifest; no findings/blockers |
| missing fields | none |
| invalid fields | official preflight command used literal `...` instead of the exact `SPEC_PATH` |
| extra output | none |
| ordering/syntax | otherwise schema-compatible |
| failure category | `B — INVALID_FIELD_VALUE` |
| causal layer | validation-runner output contract; main quality manager correctly rejected the abbreviated command |

Minimal observed fragment:

```text
node /Users/ajfiumanee/projects/private/sentinel-workflows/skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs ... VALIDATE_SLICE 1
```

The raw terminal child message remained in the forensic session's owned OS-temp
root through classification, causal correction, and regression. No provider
log, transcript, or chain-of-thought was persisted in this repository.

## R07 correction

| Path | Semantic delta |
| --- | --- |
| `agents/codex/.codex/agents/stnl_validation_runner.toml` | Bump canonical contract to v8; require exact complete `VALIDATE_SLICE` commands; forbid ellipsis, placeholders, omitted arguments, and PASS with abbreviated commands. |
| `agents/claude-code/.claude/agents/stnl-validation-runner.md` | Apply the same v8 contract semantics to the Claude adapter. |
| `scripts/check-contracts.mjs` | Add `R020_EXACT_COMMANDS` contract guards. |
| `scripts/test-validation-runner-contract.mjs` | Add the focused observed-ellipsis regression and mutation rejection. |

No authority algorithm, lifecycle architecture, execution schema, launcher,
quality-manager behavior, Production Profile, Case, seed, model assignment,
budget, Environment contract, or Agent Harness core changed.

## Regression

| Check | Result |
| --- | --- |
| canonical adapters accepted under contract v8 | PASS |
| exact full official-preflight command fixture accepted | PASS |
| observed literal-ellipsis command classified as abbreviated | PASS |
| mutation permitting abbreviated commands rejected as `R020_EXACT_COMMANDS` | PASS |
| validation-runner contract suite | 93/93 PASS |

## Isolated R07

`BLOCKED`

The fresh isolated call advanced beyond the previous malformed result: Harness,
main session, and child session started; the runner returned formal `PASS` with
the corrected exact command behavior. The quality manager then refused terminal
publication because the deterministic fixture had persisted the changed path as
`../../../workspaces/r07-isolated/src/invitation.mjs`. From the live task path,
that path resolved absent, so terminal ownership validation rejected the
candidate. No attempt, Effective Validation Base, final result, or global-row
completion was published. Official state remained
`IMPLEMENTED_AWAITING_VALIDATION`.

This is not a recurrence of the ellipsis failure, but F06 did not reach
`COMPLETE`. The explicit F06 stop-loss therefore prohibited another correction
or the full rehearsal.

## Full rehearsal

| Stage | Result | Evidence |
| --- | --- | --- |
| R01 | NOT_RUN | Full rehearsal gated on isolated R07 PASS. |
| R02 | NOT_RUN | Full rehearsal gated on isolated R07 PASS. |
| R03 | NOT_RUN | Full rehearsal gated on isolated R07 PASS. |
| R04 | NOT_RUN | Full rehearsal gated on isolated R07 PASS. |
| R05 | NOT_RUN | Full rehearsal gated on isolated R07 PASS. |
| R06 | NOT_RUN | Full rehearsal gated on isolated R07 PASS. |
| R07 | NOT_RUN | Isolated F06 blocked before full rehearsal authorization. |
| R08 | NOT_RUN | Dependent on full R07 PASS. |
| R09 | NOT_RUN | Dependent on R08 PASS. |
| R10 | NOT_RUN | Dependent on R09 PASS. |
| R11 | NOT_RUN | Dependent on R10 PASS. |
| R12 | NOT_RUN | Dependent on R11 PASS. |
| R13 | NOT_RUN | Dependent on R12 PASS. |

## Live calls

| Stage | Purpose | Requested model | Effort | Harness status | Semantic status | Retry count |
| --- | --- | --- | --- | --- | --- | ---: |
| R07_FORENSIC | reproduce and capture malformed child output | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | `RUNNER_RESULT_BLOCKED`; abbreviated command | 0 |
| F06 | isolated R07 after correction | GPT-5.6-Luna | high | `HARNESS_COMPLETED` | runner `PASS`; terminal candidate blocked by absent fixture path | 0 |

Both delegated validation children used the configured GPT-5.6-Luna / medium
runner. No external retry occurred.

## Reviewer

`NOT_RUN — isolated R07 did not reach COMPLETE`

## Parallel smoke

- B start: not run;
- C start: not run;
- overlap: not claimed;
- isolation: not evaluated;
- cleanup: isolated F06 session cleaned independently; forensic raw remained in
  its owned OS-temp root through causal analysis and regression.

## Remediation cycles

Exactly one correction cycle was used: the causal R07 runner-contract v8
correction. The optional post-R07 remediation was not authorized because
isolated R07 did not pass. There was objective advancement from malformed output
to a valid runner PASS, followed by a distinct fixture path-basis blocker.

## Historical integrity

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

## Final checks

| Command/check | Result |
| --- | --- |
| `node scripts/test-validation-runner-contract.mjs` | PASS, 93/93 |
| `node scripts/check-contracts.mjs validation-runner --root agents` | PASS |
| `git diff --check` after focal correction | PASS |
| historical Pilot #1–#4 raw SHA-256 | PASS, byte-identical |
| full R13 suite | NOT_RUN; prohibited after F06 BLOCKED |

## Next

No Production Pilot is authorized. The failed stage is isolated F06; category
`FIXTURE_PATH_BASIS`; objective blocker is the absent path encoded by the
POST-R06 deterministic fixture; last passing stage is the focused regression;
one remediation cycle was used; objective advancement occurred past the former
malformed-output cause.

## Resulting commit

`bfe0a190993d48428acaaa827b84a6db2e4124b1`
