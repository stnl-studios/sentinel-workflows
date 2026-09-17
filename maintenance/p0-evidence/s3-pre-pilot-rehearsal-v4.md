# S3 Pre-Pilot Rehearsal v4

## Status

`PRE_PILOT_REHEARSAL_BLOCKED`

## Base

`f3aea3598620a4f9d214ab3df44e0f935e058168`

- branch: `feature/atlas-p0`
- parent: `bfe0a190993d48428acaaa827b84a6db2e4124b1`
- commit: `fix(benchmark): correct rehearsal fixture path basis`
- published branch HEAD: confirmed on `origin/feature/atlas-p0`
- initial working tree: clean, with no relevant untracked files
- Production Profile: `production-v2`
- Environment v1: `ENVIRONMENT_READY`
- Agent Harness v1: `HARNESS_COMPLETED`
- capability hash: `a35d6560c398bc4665b67df364432079a63032c394b03ec85194f552a1e60441`

## Previous blocker

R11 `HARNESS_INIT_FAILED` before reviewer session start.

## Git geometry proof

Before correction, all three rehearsal callers created only a directory. The
critical fixture used by the already-proven execution stages initialized a
local Git repository.

| Workspace | Before Git | After Git | Canonical | Managed | Outside repo |
| --- | --- | --- | --- | --- | --- |
| reviewer | `.git` absent; `rev-parse` exit 128 | `.git` present; `rev-parse=true` | yes | yes | yes |
| B | `.git` absent; `rev-parse` exit 128 | `.git` present; `rev-parse=true` | yes | yes | yes |
| C | `.git` absent; `rev-parse` exit 128 | `.git` present; `rev-parse=true` | yes | yes | yes |

The critical fixture comparison returned `.git` present and
`git rev-parse --is-inside-work-tree=true`. This confirms
`HARNESS_WORKSPACE_GIT_GEOMETRY` as the causal R11 hypothesis: the same
reviewer model/effort/sandbox started successfully after only the workspace Git
geometry changed.

## Correction

| Path | Semantic delta |
| --- | --- |
| `benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs` | Add a rehearsal-only Git geometry inspector and `prepareHarnessWorkspace`; initialize reviewer/B/C workspaces with local `git init --quiet`; preflight them before live calls; expose isolated R11/R12 entrypoints; preserve real parallel B/C start and independent cleanup. |
| `scripts/test-benchmark-rehearsal.mjs` | Add G01-G05 and raw-mkdir negative regression coverage. |
| `maintenance/p0-evidence/s3-pre-pilot-rehearsal-v3.md` | Replace only the pending resulting commit with the published v3 SHA. |
| `maintenance/p0-evidence/checkpoints.md` | Freeze the v3 checkpoint and append the factual v4 checkpoint. |
| `maintenance/p0-evidence/README.md` | Add v4 without removing prior evidence. |
| `maintenance/p0-evidence/s3-pre-pilot-rehearsal-v4.md` | Record the v4 proof, isolated results, and full-run blocker. |

No global Git setting, local commit, Harness core, Environment core, execution
runtime, authority algorithm, validation runner, lifecycle runtime, profile,
seed, Case, budget, result schema, or journal schema changed.

## Deterministic regressions

| ID | Result | Evidence |
| --- | --- | --- |
| G01 reviewer workspace | PASS | canonical, inside its managed workspaces root, outside checkout, own `.git`, `rev-parse=true` |
| G02 B smoke workspace | PASS | canonical, inside its managed workspaces root, outside checkout, own `.git`, `rev-parse=true` |
| G03 C smoke workspace | PASS | canonical, inside its managed workspaces root, outside checkout, own `.git`, `rev-parse=true` |
| G04 independence | PASS | B/C workspace, `.git`, session root, and runner TMPDIR all differ |
| G05 no global mutation | PASS | Git global fingerprint remained `8d46a7bac031f79ee62ffc7b85abdea27a03b9f9d69660657d9cd6d272e1ce4e` |
| negative raw workspace | PASS | mkdir-only managed workspace returned `HARNESS_WORKSPACE_GIT_NOT_READY` before model launch |
| focused rehearsal suite | PASS | 8/8 tests |

## Isolated R11

- preflight: `HARNESS_WORKSPACE_GIT_READY`
- model: GPT-5.6-Sol
- effort: high
- sandbox: read-only
- Harness result: `HARNESS_COMPLETED`
- providerInvocationAccepted: true
- sessionStarted: true
- turnStarted: true
- semantic verdict: `PASS`
- retry: 0
- result: `ISOLATED_R11_PASS`

## Isolated R12

| Fact | B | C |
| --- | --- | --- |
| model / effort | GPT-5.6-Luna / medium | GPT-5.6-Luna / medium |
| sandbox | workspace-write | workspace-write |
| Git preflight | READY | READY |
| Harness | `HARNESS_COMPLETED` | `HARNESS_COMPLETED` |
| sessionStarted / turnStarted | true / true | true / true |
| result marker | `B_ONLY_71f2` | `C_ONLY_9ac4` |
| retry | 0 | 0 |

- real overlap: PASS
- workspace/session/TMPDIR/Git isolation: PASS
- cross marker read/write: not observed
- independent cleanup: PASS
- result: `ISOLATED_R12_PASS`

## Full rehearsal

The full run used a fresh root and reused no isolated workspace.

| Stage | Result | Evidence |
| --- | --- | --- |
| R01 | PASS | canonical authority current and non-stale |
| R02 | PASS | authority mutation produced `REQUIREMENTS_CHANGED` and `REPLAN` recovery |
| R03 | PASS | runner v8 accepted; R019/R020 negative contracts rejected |
| R04 | PASS | valid BLOCKED stops after one event/check with zero re-entry |
| R05 | PASS | fresh `MATERIALIZED_PRISTINE` fixture and canonical path gate |
| R06 | PASS | Harness completed; one `TESTS_PASS`; `IMPLEMENTED_AWAITING_VALIDATION` |
| R07 | FAIL | pre-live path gate rejected `src/invitation.mjs` in Changed Areas and tested state; zero VALIDATE calls started |
| R08 | NOT_RUN | prohibited after R07 failure |
| R09 | NOT_RUN | prohibited after R07 failure |
| R10 | NOT_RUN | prohibited after R07 failure |
| R11 | NOT_RUN | full-run reviewer prohibited after R07 failure; isolated R11 PASS remains factual |
| R12 | NOT_RUN | full-run parallel smoke prohibited after R07 failure; isolated R12 PASS remains factual |
| R13 | NOT_RUN | prohibited after R07 failure |

The observed R07 rows resolved the live EXECUTE claims relative to
`spec/execution/tasks/slice-01.md`, producing the absent target
`spec/execution/tasks/src/invitation.mjs` rather than
`workspace/src/invitation.mjs`. This is new causal evidence after the authorized
Git-geometry correction. Per the v4 remediation policy, it was not corrected
and the rehearsal was not retried.

## Execution chain

Factual chain reached in the fresh full run:

`MATERIALIZED_PRISTINE`
→ `EXECUTE`
→ `TESTS_PASS`
→ `IMPLEMENTED_AWAITING_VALIDATION`
→ pre-live `FIXTURE_PATH_BASIS_BLOCKED`

No VALIDATE, COMPLETE, GLOBAL READY, CLOSED, full reviewer, full parallel
smoke, or R13 PASS is claimed for this run.

## Reviewer

- isolated reviewer: `PASS`
- full reviewer: `NOT_RUN` because the full rehearsal stopped at R07

## Parallel smoke

- isolated B/C smoke: `PASS`
- full B/C smoke: `NOT_RUN` because the full rehearsal stopped at R07

## Final suite

R13 was not run because R07 failed. The pre-live gate prevented a validation
model call, and no second full rehearsal was started.

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

## Objective advancement

- Git geometry hypothesis: confirmed;
- authorized correction: deterministic regression PASS;
- isolated R11: PASS;
- isolated R12: PASS;
- fresh full rehearsal: advanced through R06 and exposed a new R07
  file-backed path claim before spending a validation call;
- failed stage: R07;
- failure category: `FIXTURE_PATH_BASIS`;
- last passing stage: R06.

No Production Pilot, qualification, extra rehearsal, audit, or hardening was
run.

## Resulting commit

`b1fb9e182c15a2442aba09872cf11f3e6d49dd13`
