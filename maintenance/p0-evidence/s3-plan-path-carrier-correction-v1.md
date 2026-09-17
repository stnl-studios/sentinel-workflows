# S3 PLAN Path-Carrier Correction v1

## Status

`PLAN_PATH_CARRIER_LIVE_PROOF_BLOCKED_OTHER`

The producer correction and deterministic evidence passed. The fresh Case A
SPEC reached `ready` / `EMPTY`, but the single Terra/high PLAN turn published no
planning artifacts and official readback remained `EMPTY`. The sanitized Agent
Harness summary retained one command exit `1` but not its diagnostic text, so
candidate validation PASS and the failure class cannot be claimed. No retry or
second correction was attempted.

## Base

- branch: `feature/atlas-p0`
- HEAD: `c3be9c353890e45a51e4d8f8db1329bce8a1b7d5`
- parent: `6de87f5d3d8f02ee27b8826942481c0529496291`

## Observed production blocker

- Production Pilot #7 stopped at PLAN candidate rejection.
- The rejection named `plans/slice-02.md` and invalid resolved path
  `plans/list`.
- The rejected candidate was not published and live execution remained
  `EMPTY`.

## Root cause

`NON_PATH_INLINE_CODE_IN_IMPLEMENTATION_PATH_CARRIER`

Global `Expected areas` and detailed `Likely Areas` treat every inline code span
as a machine-significant filesystem claim. The producer wording and templates
still allowed Markdown-style conceptual code spans, while the validator
correctly rejected the resulting path claim.

## Correction

| Path | Change |
|---|---|
| `skills/workflows/stnl-execution-planner/SKILL.md` | Reserve carrier code spans exclusively for concrete paths; require artifact-relative basis, plain-text concepts, and no invented paths. |
| `skills/workflows/stnl-execution-planner/templates/plan.template.md` | Label the code span as filesystem path and keep the conceptual description outside it. |
| `skills/workflows/stnl-execution-planner/templates/slice-plan.template.md` | Apply the same compact separation to detailed Likely Areas. |
| `scripts/test-execution-contract.mjs` | Add P01-P05 causal coverage and align existing rendered-template fixtures. |
| `scripts/check-contracts.mjs` | Guard the path/description separation in both planner templates. |
| `maintenance/p0-evidence/s3-benchmark-pilot-07.md` | Close Pilot #7 resulting-commit bookkeeping. |
| `maintenance/p0-evidence/checkpoints.md` | Close Pilot #7 and record this pending correction checkpoint. |
| `maintenance/p0-evidence/README.md` | Index this correction evidence. |
| `maintenance/p0-evidence/s3-plan-path-carrier-correction-v1.md` | Record this correction and focal live proof. |

No execution-state runtime or distributed validator copy changed.

## Regression

| Case | Evidence | Result |
|---|---|---|
| P01 | Real detailed implementation path in inline code resolves to the expected physical target. | PASS |
| P02 | Plain-text `list command behavior` creates no path claim. | PASS |
| P03 | Deliberate inline-code `list` remains a path claim and is rejected inside the execution root. | PASS |
| P04 | Global path code span plus plain-text conceptual description. | PASS |
| P05 | Detailed path code span plus plain-text conceptual description. | PASS |

## Deterministic checks

| Check | Result |
|---|---|
| `git diff --check` | PASS |
| focused path-carrier regression | 1/1 PASS |
| execution contract suite | 94/94 PASS |
| repository contract check | PASS |
| `bash scripts/validate.sh --no-smoke` | PASS |

## Live proof

| Operation | Model | Effort | Result | State |
|---|---|---|---|---|
| SPEC_INIT | GPT-5.6-Sol | high | PASS | lifecycle `ready`; execution `EMPTY` |
| PLAN | GPT-5.6-Terra | high | BLOCKED before publication; diagnostic text unavailable in sanitized Harness summary | `EMPTY` |

The PLAN Harness turn completed with zero retry and 11 observed command
executions; the last command exited `1`. Official `--handoff-after PLAN`
readback found no planning set, no normal handoff, and `PLAN` still legal.
Candidate validation PASS was not established.

## Path-carrier inspection

- concrete path claims: not inspectable; no planning artifact was published;
- artifacts containing claims: none;
- correct resolutions: not established by the live proof;
- non-path inline-code count: not inspectable; no published carrier fields.

## Retry

0.

## Historical integrity

PASS. Prior Pilot raws, the Pilot #5 historical missing-raw fact, Pilot #6
evidence, Pilot #7 raw, and rehearsal evidence remained byte-identical. Pilot
#7's historical conclusion is unchanged; only its evidence resulting-commit
field was resolved.

## P0 ledger

- G1 PROVEN
- G2 PARTIAL
- G3 PARTIAL
- G4 PROVEN
- G5 PROVEN
- G6 NOT_YET_PROVEN

No gate was promoted.

Baseline: `NOT_YET_ESTABLISHED`

## Next

User decision is required before any further correction or live PLAN attempt.
Production Pilot #8 is not authorized from this blocked checkpoint.

## Resulting commit

`c0efb3f7a38897c545798cb0ac57599b5fc240da`
