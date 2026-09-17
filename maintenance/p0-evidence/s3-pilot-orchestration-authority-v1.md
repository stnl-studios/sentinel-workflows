# S3 Pilot Orchestration Authority v1

## Status

`PILOT_ORCHESTRATION_AUTHORITY_BLOCKED_HARNESS`

The only live Harness request was rejected before provider or model start
because the managed workspace was supplied through the non-canonical `/tmp`
alias. On this host its canonical path is under `/private/tmp`. Stop-loss was
honored: there was no retry or second `SPEC_INIT`.

## Base

- branch: `feature/atlas-p0`
- HEAD: `3b7777a875abd022a0c4f43a7ea6bde583a2fb16`
- parent: `0be86e69801f51ae32612275bb31f8823b52a5bf`

The branch HEAD was published and the checkout was clean before the session.

## Production blocker

Production Pilot #8 had a successful Sentinel `SPEC_INIT`: official lifecycle
was `ready`, execution was `EMPTY`, and the legal handoff was `PLAN`. The
external driver nevertheless recorded `BLOCKED` after searching for the
non-canonical list form `- status: ready` in Markdown. Root cause:
`DRIVER_AD_HOC_SEMANTIC_REINTERPRETATION`.

## Authority rule

`official readback > model prose / ad hoc artifact parsing`

The operation-specific official validator/readback is the primary semantic
authority. This rule is bidirectional: official success is not downgraded by an
auxiliary parser, and model prose cannot override an official blocker. The
boundary mapping used for this session was: lifecycle operations use official
lifecycle validation/readback; planning and execution operations use official
execution candidate/post-operation readback plus their canonical auxiliary or
formal validation result where applicable; benchmark finalization uses the
canonical result JSON; provider and transport use the Benchmark Agent Harness.
This introduces no new runtime authority.

## Regression

| Check | Result |
|---|---|
| D01 | PASS |
| D02 | PASS |
| D03 | PASS |
| D04 | PASS |
| D05 | PASS |

D02 confirmed that the canonical ready fixture contains no exact
`- status: ready` line while official lifecycle and execution authorities still
produce `ready`, `EMPTY`, and `PLAN`. D03 and D04 confirmed that apparent ready
text or model `PASS` cannot override an official blocker.

## Live proof

| Operation | Model | Effort | Harness | Official lifecycle | Execution | Handoff | Recorded result |
|---|---|---|---|---|---|---|---|
| SPEC_INIT | Sol | high | `HARNESS_INIT_FAILED` | not run | not run | not run | `BLOCKED` |

- session started: no
- model turn started: no
- provider invocation accepted: no
- transport status: `HARNESS_INIT_FAILED`
- factual diagnostic: `cwd must already be canonical`
- prepared Case Git: clean
- SPEC path after rejection: absent

## Ad hoc parser

`used for semantic decision: no`

`ad_hoc_markdown_status_parser_used = false`

## Retry

0.

## Functional diff

`none`

HEAD and tree remained unchanged through the live attempt. No lifecycle skill,
lifecycle runtime, execution skill, execution runtime, planner, executor,
quality manager, validation runner, launcher, benchmark runtime, Harness,
Environment, Production Profile, Case, seed, or schema was modified.

## Historical integrity

PASS. Existing raws, Pilots #1–#8, rehearsal evidence, PLAN correction, and PLAN
observability evidence were preserved. No benchmark raw was created and no
historical outcome was rewritten.

## P0 ledger

- G1 PROVEN
- G2 PARTIAL
- G3 PARTIAL
- G4 PROVEN
- G5 PROVEN
- G6 NOT_YET_PROVEN

## Baseline

`NOT_YET_ESTABLISHED`

## Next

Production Pilot #9 is not authorized by this blocked proof. The next session
must use canonical managed-session paths before any Harness invocation and must
retain the official-readback-first rule. No retry, additional live operation,
or Pilot #9 occurred here.

## Resulting commit

`pending user commit`
