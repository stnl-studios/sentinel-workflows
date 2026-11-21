# Sentinel benchmark: development qualification

App Server engine, frozen Node Todo baseline, independent `rename`, `query`, and `import` tasks. Every task starts from the same functional snapshot, never another task's output. The transversal `import` task has at least two naturally scoped serial slices; each must earn its own formal PASS before the next, followed by real CLOSE. Immutable before/after authority snapshots retain historical PASS even if a later slice changes a shared file. `trajectory-report.json` records observed shared-file changes without requiring artificial edits; product acceptance remains an independent oracle.

## Commands

From the Sentinel repository root; the launcher materializes the runtime inside ignored benchmark-temp:

```sh
npm run benchmark:test
node scripts/run-benchmark.mjs validate-profile
node scripts/run-benchmark.mjs run --id unique-diagnostic
node scripts/run-benchmark.mjs status --id unique-diagnostic
node scripts/run-benchmark.mjs report --id unique-diagnostic
```

Public `run --id ID` executes two repetitions of each of three independent tasks with three slots. No best-of selection. Default is **diagnostic**. A running campaign is not a qualification certificate or evidence that the current edited engine passed.

Official use is fail-closed:

```sh
node scripts/run-benchmark.mjs qualify --id qualification-id --input evidence/qualification-input.json
node scripts/run-benchmark.mjs run --id future-measurement --mode official --qualification evidence/qualifications/qualification-id/qualification.json
```

The qualification input explicitly identifies the reference harness, all declared diagnostic cells and proof files, plus local/live checks. The collector verifies actual proof bytes and bindings; it does not generate missing passes. The reference must cover all three tasks twice and prove each CLOSE/oracle path. A changed target Sentinel revision/model need not pass to become measurable: its Git snapshot, profile, models, security acknowledgments and runtime interfaces must be compatible with the qualified harness. Those zero-turn checks do not claim end-to-end compatibility. Harness, fixture, oracle, context policy, protocol or CLI changes require requalification. Diagnostics are never promoted retroactively. Official and invalid/diagnostic observations stay separately labeled, including failures.

## Configuration and evidence

The launcher uses `bench/profiles/reference-v5-observe.json`; supply `--profile PATH` for a custom C3 profile with the same full matrix. Roles and optional stage-role mappings select advertised models and reasoning effort without implicit fallback. Effective profile and provider acknowledgments are saved. `contextPolicy: stage` opens a coordinator thread per operation/slice; corrections and safe resumes within that stage keep its thread. The independent plan approver evaluates captured bytes; native plan review and formal slice validation remain separate real Sentinel steps.

Source snapshot materialization and admission are preflight, outside measured task duration. Preparation and model execution have bounded deadlines; guards observe tokens during turns, but delayed/unreported usage means they are not hard spending caps. Cache is part of input; reasoning is part of output. Reports expose known usage and gaps, not billing estimates. Two repetitions do not establish a statistical ranking.

Evidence: `evidence/campaigns/ID/`; working copies: `work/campaigns/ID/`. Both are beneath the outer ignored `benchmark-temp` tree. Each campaign preserves engine snapshot, identity, effective profile, durable ledger, checkpoints, accepted thread/turn IDs, per-cycle usage, failure classification, captured approvals, native communication evidence, external oracle and report. Missing native communication evidence is not fabricated. Public resume is disabled until ownership and termination can be re-proved; status and report remain available. Do not rerun an uncertain dispatch or remove its lock.

The main repository, global installation, Claude and old measurements are not modified. IDs cannot be reused. On macOS the host must be able to launch Codex's own sandbox; nested seatbelt may fail with exit71. Use the supported authorized execution channel, never disable Codex protection. All temporary folders are inside benchmark-temp, including model TMPDIR; system `/tmp` is excluded from writable roots.

Historical transport POC stays under `code/` and its original evidence. See `docs/BUILD_PLAN.md`. Current status is development and diagnostic verification, **not a completed or officially qualified benchmark**.

## Current calibration evidence

`engine-stage-07` completed the small task with real CLOSE and independent pre/post oracle PASS: 22m47s, 6,154,408 reported tokens (5,497,856 cached input; 598,268 new input; 58,284 output). Original automatic classification remains diagnostic/invalid because the old role-name collector did not recognize `_slice_01_round_1` suffixes. Separate post-audits prove role/configuration and source-contract bindings; original results were not rewritten or promoted. The collector correction has unit coverage. These are reported usage categories, not a price estimate, and a single task does not qualify the harness or predict complex-task cost. Full six-cell qualification has not run.

`engine-import-08` was interrupted by host disconnection while validating its first slice. At reconnection no matching runner process remained and the original deadline had expired. Its checkpoint still says RUNNING with an unsettled turn; `post-audit-reconnection.json` records this external observation without rewriting the original state or claiming a terminal provider outcome. Expired runs are not resumed by resetting their budget. This preserves evidence but currently does not provide pause-aware continuation across a long host outage.

## Hardened engine checks and provider availability

The hardened engine passed 282 local tests plus two new live synthetic probes: two no-progress turns stopped before a third (27,263 reported tokens); worker interruption followed by independent effect/claim verification and read-only continuation preserved one effect (38,913 reported tokens, killed-turn reporting may be incomplete). These probes are not a full Sentinel recovery guarantee.

`stage-medium-calibration.json` explicitly lowers only routine coordinator effort, not checkers or requirements. Its first diagnostic `engine-import-09-medium` never reached functional execution: the provider reported model capacity and the turn ended on `TURN_DEADLINE`, with no usage records (null, not zero). It does not establish quality, cost or latency improvement. Observed wall duration exceeded the configured timer after host connectivity interruption; process timers cannot promise an exact wall-clock cutoff while the host is unavailable or suspended. Original results remain unchanged.

Availability classification uses the exact terminal thread/turn IDs. Unresolved public capacity errors are kept separate from the deadline that stopped the turn; later completion or observed progress prevents blaming an old retry. `post-audit-provider-classification.json` applies this corrected collector to preserved import09 events without changing its original result or promoting it.

## Per-task, per-stage profiles

The global profile is a default, not a requirement that all tasks use one combination. `caseOverrides.rename`, `.query` and `.import` can override `roles` and `stageRoles` independently in the same campaign. See `bench/profiles/case-stage-example.json` (illustrative GPT configurations, not a claim of optimality or permanent availability). An override role supplies both `model` and `effort`. `stageRoles` selects the coordinator; `plan_approver`, `plan_review`, `execute_check` and `formal_validate` select independent actors separately. A strong validation coordinator does not silently change its child validator. Overrides cannot change source, fixture, security, budgets or concurrency.

Each cell persists the full requested campaign profile and its resolved effective profile before workspace preparation. Dispatch, role configuration, telemetry expectations and resume use that resolved profile. The human report labels requested configuration separately from observed acknowledgments. Preflight checks every selected task's effective model/effort without fallback. The normal campaign accepts heterogeneous configurations; controlled comparison is optional.

## Optional controlled comparison

`compare` reads existing campaign evidence and writes a separate report; it does not run models or promote diagnostics. Provide a confined JSON input such as:

```json
{"baselineId":"baseline-fixed","candidateId":"candidate-execute-medium","contract":{"kind":"stage-model-effort","target":{"caseIds":["import"],"stage":"EXECUTE_SLICE","actor":"coordinator","vary":["effort"]}}}
```

```sh
node scripts/run-benchmark.mjs compare --id comparison-id --input evidence/comparison-input.json
```

`sentinel-evolution` permits only the selected Sentinel source/revision to change while effective task/stage/actor configurations and other controls stay fixed. `stage-model-effort` permits only the declared actor/stage/task model or effort changes. Shared role changes that also affect another stage are not an isolated experiment. Pairs use task and repetition, never assign one model exclusively to each difficulty. Missing stages, tokens or observations remain missing rather than zero. Outcomes and diagnostic classifications remain intact. Small samples support descriptive deltas only, not statistical ranking or causal claims; changing an early stage can also change downstream inputs. Stable model names do not prove an immutable provider backend.

## Execution-context calibration

Import10's source recipe and independent oracle passed, but final formal validation was BLOCKED by execution-context staleness. A separate reproduction found that adding shell commands after Node changes SHLVL, which the selected runtime includes in its environment digest. The historical receipt stores only that digest, so the original SHLVL value was not recovered. Future prompts require consistent direct launches with Node last and no environment normalization; stale evidence is never relabeled PASS or replayed. See the preserved `post-audit-context-staleness` evidence. This is distinct from product acceptance and still does not qualify the full benchmark.

### Explicit BLOCKED revalidation boundary

The selected Sentinel source supports a separate `begin --retry-blocked` path after a settled formal BLOCKED result. `blocked-revalidation.mjs` supplies a read-only collector and conditional decision helper, disabled by default. It requires pinned authority/receipt/product evidence, explicit delegated authorization, an original remaining budget and a stable-launcher probe. Its decision is not Sentinel admission and never certifies PASS. Automatic campaign dispatch through this branch is not enabled or qualified yet. Uncertain producers are never replayed; expired import10 remains closed as a diagnostic attempt.

## Prospective native-role evidence and reading discipline

The campaign collector uses `roleAuthority: native`. Execution/check and formal-validation roles require successful literal official `reserve-dispatch` and `bind-native` command outputs, matched by parent thread/turn, handle, origin, request digest and unique native child identity. Missing, conflicting, redirected or unsupported proof remains UNKNOWN; no replay is allowed merely to recreate a log. Command parsing deliberately supports a bounded grammar, not arbitrary shell programs. The standalone collector retains an explicitly weaker `name-fallback` mode for diagnostics only.

The plan-review child is attributed through a dedicated REVIEW_PLAN parent and a unique direct child, not its name or model. This proves role attribution, not approval: the separate plan-capture/approval byte-binding gate remains required. Conflicting native relationships cannot establish a role.

Stage instructions reuse persisted output only within the same confirmed context/state, prefer selected JSON evidence fields over repeated full dumps, and preserve every contract-required full read and each child's independent reading. These are prospective instructions, not a guarantee of lower usage.

Import11 demonstrated both slices PASS, COMPLETE, CLOSE and the external oracle in 33m30, but its original measurement admission is invalid because one child's name was not recognized. Preserve that result and its post-audits as diagnostics. It reported 11,643,180 tokens (10,496,640 cached input, 1,064,379 new input, 82,161 output), close to the unchanged 12M/case limit. A new bounded gate is required before the six-cell matrix; do not retroactively certify import11 with this collector or silently raise budgets.

The prospective collector now accepts bounded quoted literal arguments and the explicitly supplied isolated TMPDIR for operation handles; expansion, operators, traversal, symlinks and unrelated roots remain rejected. The original matrix is not rewritten by this correction. See [READINESS.md](READINESS.md) for the complete diagnostic outcome and the explicit qualification boundary.

## Parallel campaign

The repository launcher runs the full reference matrix with 3 slots. One campaign queues
`rename-1, query-1, import-1, rename-2, query-2, import-2`; when any slot is released,
it takes the next cell without a wave barrier, even if the same scenario is still running.
Each cell has its own workspace, temp, Codex home, App Server and evidence. The provider
account and Mac CPU/I/O are shared. A blocked cell remains in the report; case limits are
independent, with a shared campaign deadline that prevents new starts. A coordinator
persistence/control failure stops issuance and lets launched workers drain; missing direct
App Server exit evidence blocks refill rather than assuming a clean slot.

The public launcher accepts only the full matrix with 3 slots and two repetitions.
Single-cell probes and test fixtures are internal, not a second live mode. Old results
remain readable through status/report/compare, but cannot launch a serial fallback.
A historical serial qualification does not admit a parallel target. The terminal summary preserves FIFO and per-cell wall timestamps,
while the report's overlap peak counts accepted-and-completed turn intervals measured by
the App Server client, not preparation, CPU usage, or exact provider compute time. No
claims about capacity or simultaneous descendants are inferred from requested slots.

For parallel qualification, the campaign descriptor includes `turnProofs`, keyed by
`<scenario>-<repetition>`. For each reported provider window (in order), include
`{request: {ref, sha256}, result: {ref, sha256}}` pointing to its original cell's
`turn-N-request.json` and `turn-N-result.json`. The verifier checks both file bytes,
request and completion IDs, and exact observed timestamps before counting overlap.
