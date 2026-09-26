# S3 benchmark simplification — S1 feasibility stop

## Base and objective

- Branch `feature/atlas-p0`; HEAD `083c9dde527d4df1039d57065b3c3d624d04bae5`; parent `b2630fac3529f72146d050ce662ada3b145b4280`; `origin/feature/atlas-p0` matched HEAD before edits.
- Working tree was clean, `git diff --check` passed, and no benchmark case process was running.
- Objective: run ordinary Sentinel skills through an isolated, subscription-authenticated Codex SDK manager, with visible retained artifacts and one frozen A/B/C revision.
- The prior C137–C142 ledgers explain bounded controller recovery and the remaining A/B/C proof gap; they are historical diagnostics, not proof for this revision.

## S1 result

`SUBSCRIPTION_AUTH_VERIFIED` for the probe. The installed global CLI and locally tested SDK were both `0.154.0`. The CLI launched with a fresh `CODEX_HOME` containing only an opaque copy of the ChatGPT auth cache and a minimal benchmark config reported `Logged in using ChatGPT`. No SDK `apiKey`, `OPENAI_API_KEY`, or `CODEX_API_KEY` was supplied. The configured provider was `openai` with no custom base URL. SDK streaming produced `thread.started`, tool events, and `turn.completed` with usage. `resumeThread(id, options)` continued the same thread with Luna effort changed from `medium` to `low`; a separate runner thread had a distinct ID. Persisted `turn_context` entries confirmed those requested model/effort values.

`MAIN_ISOLATION_VERIFIED` **failed**. In the fourth and last allowed initial live call, the CLI used a second fresh `CODEX_HOME`, a separate shell `HOME`, disabled apps/plugins/remote plugins/hooks/memory/multi-agent/skill search, disabled bundled skills, and configured `shell_environment_policy.exclude` for `CODEX_HOME` and API-key variable names. The agent's shell still received `CODEX_HOME` pointing to the private auth cache. The agent ran `env | rg '^CODEX_HOME='` and reported the variable present. This gives the case agent a route to locate the copied credential file under the same OS user. No case was started. The exact reason the shell filter was ineffective for this tool path is not yet established; the observed environment exposure is sufficient to block migration.

A model-free check of the alternative `cli_auth_credentials_store = "keyring"` in a new empty home failed because this host has no default keychain. That check made no SDK turn and did not change global authentication.

The run is retained at `benchmark-temp/s1-2026-09-24T16-05-53-249Z-b993e3c5/`. Its `probe/events-summary.json` contains sanitized event types, thread IDs, responses, and usage; `probe/isolation-observation.json` retains the shell check with the private path redacted. Neither contains credential values or private reasoning. The opaque auth copies and provider session stores were removed after all probe processes ended. The run records a mission cap of 100 SDK turns, with 4 consumed and no provider-internal request count available. Input/output/cached token totals reported by the SDK: 102,477 / 745 / 80,896. These are usage counters, not billing.

## Component map before migration

| Decision | Component | Actual responsibility | Intended destination / preserving check |
| --- | --- | --- | --- |
| KEEP | `benchmark.mjs`, manifest, seed, raw schemas | Prepare Git-backed fixtures, verify hashes, journal, finalize and read historical results | Benchmark boundary; repository and benchmark contracts |
| KEEP | Execution state, candidate validators, serializers and publishers in `skills/workflows` | Official state machine, hashes, ownership and publication | Product runtime; execution and validation contracts |
| SIMPLIFY | `benchmark-production-pilot.mjs` | Scheduling/readback plus prompt reconstruction, phrase-based recovery and validation publication | Deterministic manager limited to transport and official handoffs; prompt fidelity and scheduling tests |
| SIMPLIFY | `templates/prompts/` launchers | Human launch plus benchmark paths, helper commands and mechanical schemas | Skill/operation/normal parameters/context only; launcher contract and manual-equivalence proof |
| MOVE | Validation candidate preparation/publication currently imported by pilot | Product publication mechanics used for manual and benchmark execution | Skill runtime/normal platform adapter; execution contract |
| MOVE | Runner invocation/broker/helper | Independent runner transport and response capture, currently benchmark-owned | Normal Codex adapter if still needed; independent-runner contract |
| DELETE after replacement | Phrase classifiers, redundant rehearsal, obsolete broker wrappers/tests | Special production-v2 execution and recoveries | No active old path; regression properties retained in new manager/product tests |

No items in this map were moved or deleted. The current implementation remains the active benchmark.

## Checkpoint and gates

S1 stopped at credential isolation. S2 and S3 were not started. No snapshot, template simplification, full local suite, Case A, Case B, or Case C was run. There is no new functional PASS, no official baseline, and no change to the P0 ledger: G1 PROVEN, G2 PARTIAL, G3 PARTIAL, G4 PROVEN, G5 PROVEN, G6 NOT_YET_PROVEN.

| Check | Exit / result |
| --- | --- |
| Branch/HEAD/parent/remote/clean tree/process check | PASS before edits |
| `codex login status` in isolated home | 0 / ChatGPT |
| SDK probe, 4 streamed turns | 4 completed; fourth exposed `CODEX_HOME` |
| Empty-home keyring auth check | 1 / no default keychain |
| Local functional contracts and A/B/C | Not run; blocked at S1 |

## Decision needed

The initial live verification limit is exhausted. A supported mechanism that keeps the auth cache unavailable to case tools must be identified and then verified in a separately authorized follow-up before the SDK migration or any Case run. Disabling code-mode tools or changing shell policy is a possible investigation, not a verified fix. Do not treat the 4-turn probe as evidence of Main isolation.

Official API references checked: [SDK README](https://github.com/openai/codex/blob/rust-v0.154.0/sdk/typescript/README.md), [SDK thread API](https://github.com/openai/codex/blob/rust-v0.154.0/sdk/typescript/src/thread.ts), [SDK options](https://github.com/openai/codex/blob/rust-v0.154.0/sdk/typescript/src/threadOptions.ts), and [Codex config schema](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/config.schema.json).

## Continuation on 2026-09-24

The S1 stop above describes the first probe, not the current implementation. The continuation used Codex's restricted filesystem permissions profile with a private `CODEX_HOME` and an opaque ChatGPT auth cache copy. A model-free `codex sandbox -P sentinel-case` probe confirmed `EPERM` for Main auth, live source and a sibling workspace, while the frozen snapshot was readable and the selected case workspace and case temp directory were writable. The private home is removed on terminal cases. At a focal stop it is retained without `auth.json` so the SDK rollout can resume; the auth copy is restored only for the resumed active case. A model-free suspend/resume probe confirmed auth absence while suspended, preserved session bytes, and successful ChatGPT reauthentication after resume. No credential bytes were inspected or copied into run artifacts.

The global controllable-turn ledger is `benchmark-temp/.turn-ledger.json`. It started at 10 from the four initial S1 turns and six continuation probes; subsequent turns are reserved before SDK calls. There is no budget reset. Requested model and effort, actual SDK usage when available, thread IDs, exact sent prompts, tool events, official readback, journals and raw finalizer results are under each visible run. The locally pinned SDK and CLI packages are `0.154.0`; `agents/codex/package-lock.json` fixes the dependency tree.

### Component decisions after migration

| Decision | Component | Final responsibility / evidence |
| --- | --- | --- |
| KEEP | `benchmark.mjs`, `benchmark-environment.mjs`, manifest, seed, cases and schemas | Deterministic fixture, doctor, journal, finalizer and historical raw reading; benchmark contracts and `verify` pass. |
| KEEP | Official lifecycle, execution-state, serializers, candidate validators and publishers | Workflow state, scope, path, hash and publication authority; 118 execution contracts pass. |
| SIMPLIFY | `templates/prompts/` | Human skill/operation/normal parameter/context entry only; manager sends exact rendered versioned bytes; launcher tests pass. |
| MOVE | Runner broker and SDK invocation | Product `agents/codex/runtime/` adapter and configured independent `stnl_validation_runner`; broker contracts pass. |
| MOVE | Validation candidate copy | Product `stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs`; strict official preparer, validator and publisher retained. |
| DELETE | Old production pilot, benchmark agent harness, rehearsal, broker and runner wrappers, plus their obsolete architecture tests | Replaced by `benchmark-manager.mjs`, product adapter, focused manager/broker tests, and unchanged official publishers. Historical ledgers and raws remain. |

The manager's source snapshot includes skills, agents, templates, scripts, benchmark fixture and pinned SDK/CLI dependencies. The frozen snapshot records base SHA, dirty status, functional diff hash, source hash and snapshot hash. Each case uses only that frozen bundle; source drift blocks further work. A is the gate for concurrent B/C. `run`, `status`, `inspect`, explicit owned `clean`, and safe focal `run --resume` are implemented. The final A/B/C functional run is still pending in this checkpoint.

### Retained focal diagnoses

| Run | Last observed state | Cause and corrective boundary |
| --- | --- | --- |
| `run-20260924173045-ad13d48c` | SPEC_INIT BLOCKED | Lifecycle canonical path listing hit `EPERM` on `/Users`; exact native realpath fallback added. |
| `run-20260924173800-f93f6313` | SPEC_INIT PASS / focal stop | First official lifecycle success under isolation. |
| `run-20260924174446-ea35d0c2` | after SPEC_INIT BLOCKED | SDK inserted the case trust entry into private config; entry preseeded and checked stable. |
| `run-20260924175004-c3c47b24` | REVIEW_PLAN PASS / focal stop | PLAN and independent reviewer first reached `PLANNED_READY`. |
| `run-20260924181532-4e7ff276` | MATERIALIZE_TASKS BLOCKED | Four helper CLI guards failed to execute under a skill path with spaces; `pathToFileURL` and a path-with-spaces regression fixed them. |
| `run-20260924183624-d5785579` | PLAN BLOCKED | Valid candidate rejection for mismatched path-claim counts; skills now permit a new, strict candidate under unchanged official authority. |
| `run-20260924184514-df328dff` | PLAN BLOCKED | `:tmpdir = deny` overrode the explicit case temp write grant; removed after model-free permission matrix. |
| `run-20260924185428-7b0988b7` | REVIEW_PLAN PASS, next SDK turn BLOCKED | Same-run focal resume lost author rollout because private home was deleted; focal suspension now scrubs auth and retains the private session. Previous and resumed raws were both preserved. |

Local evidence at this checkpoint: `node --test scripts/test-execution-contract.mjs` 118/118; launcher and validation-runner contracts 122/122; manager/broker 9/9; lifecycle core 3/3; `bash scripts/validate.sh --no-smoke` PASS; `benchmark.mjs verify` PASS; repository, launcher and subagent semantic checks PASS; `git diff --check` PASS. The currently active `run-20260924191754-2bd46458` is a focal integration retest and must not be counted as a final A/B/C result.

## Final mission checkpoint: controlled budget exhausted

The preceding checkpoint is historical. The final frozen functional revision is `sha256:16e8f80d0711f78a5ee9a9edd4feec0123957f92b18c88113fef1ba66479e032`, with functional diff `sha256:0ee1b40a0ab8fd8a7363959f17832f87b2b9273544f752d182b948b665e639cb`, snapshot `sha256:d3ab2d6905ee91c928cd1f648e9a9d278e70bcbc37382e9a1c06e3422faa85c0`, and base HEAD `9f9bd4a52becd78f4d4372dcd4d52ba22d97b971`. The snapshot packaged 268 source files and 285 files including pinned dependencies. The checkout remained uncommitted. Its frozen code and templates ran all three cases in `benchmark-temp/run-20260924210317-4bc02b11/`; no source revision changed during that run. The global ledger ended at exactly **100/100** controllable turns: 4 initial S1, 6 continuation probes, 57 earlier run turns, and 33 final run turns (27 main, 6 independent runner). This is `PAUSED_BUDGET_OR_QUOTA`, not functional convergence.

| Case | Official final state | Collector | Main / runner | Observed result |
| --- | --- | --- | --- | --- |
| A | `COMPLETE`, SPEC `closed` | `PASS` | 12 / 4 | Two slices, four tasks, two execution and two formal validation calls; final tests exit 0. |
| B | `RUNNER_INITIALIZATION_BLOCKED` | `BLOCKED` | 8 / 1 | First slice implementation passed; formal validation could not start its runner after budget exhaustion. Two bounded starts returned `BROKER_DISPATCH_FAILED`, and the official task retains one active initialization blocker without a formal attempt. |
| C | `RUNNER_RESULT_BLOCKED` | `BLOCKED` | 7 / 1 | First slice code and tests were prepared; the deterministic producer rejected a runner scalar containing backticks in `nonApplicabilityRationale`. The official task retains one active malformed-output blocker and mandates `EXECUTE_SLICE slice-01` recovery. No formal validation occurred. |

The final run's raw results are `case-a/raw.json`, `case-b/raw.json`, and `case-c/raw.json` under the run path above. All three case homes used ChatGPT subscription authentication with provider `openai` and restricted filesystem permissions; each private home was removed after terminalization. The model-free sandbox probe documented above established EPERM for Main auth and live source. The immutable source snapshot, exact rendered prompts, sanitized SDK events, journals, readbacks, runner responses and collector outputs remain visible. No credential values or private reasoning were stored in the run artifacts. A rejected same-depth execution candidate remains in C's isolated workspace as evidence; it was not published. Blocked runs and historical diagnostics were not cleaned automatically.

The collector initially misclassified a prior closed A run because it expected only one `SPEC_READINESS`. The official lifecycle requires an initial and a terminal readiness call. The collector contract and B06 regression now require both in order, and a diagnostic re-finalization of that preserved run returned `PASS` without rewriting its original `FAIL` raw result. The final frozen run above exercised the corrected collector directly and A returned `PASS` without diagnostic reprocessing. The executor now prepares a same-depth isolated candidate, derives paths and hashes there, validates the complete candidate, and atomically publishes only the selected task; the live A run verified this after the earlier producer rejected pristine `Changed Areas`. The independent runner was started once per completed A check after the skill was clarified to wait for a pending process receipt.

Final offline gates before the frozen run: `bash scripts/validate.sh --no-smoke` exit 0, `benchmark.mjs verify` exit 0, B06 terminal-sequence regression exit 0, and `git diff --check` exit 0. The full final run took about 67 minutes wall time. Collector telemetry across A/B/C reports 74,738,451 input and 654,960 output tokens, including repeated context accounting; these are SDK usage counters, not cost or a comparable reduction against prior configurations. Final case artifacts report 12, 21 and 27 changed files respectively. None of these numbers establishes `FUNCTIONAL_CONVERGENCE_PASS` for all three cases or a published baseline.

The P0 ledger remains G1 PROVEN, G2 PARTIAL, G3 PARTIAL, G4 PROVEN, G5 PROVEN, G6 NOT_YET_PROVEN. The official baseline was not promoted. The minimum next decision is whether to authorize a new controllable-turn budget and a fresh same-revision A/B/C run after the C semantic-output recovery is addressed; the 100-turn mission cap cannot be reset within this run. No commit or push was made.

### Exact changed-file inventory at final checkpoint

The 63 paths below are the complete uncommitted working-tree inventory. `M` means modified, `D` deleted, and `??` newly added. Run workspaces under ignored `benchmark-temp/` are retained separately and are not part of this source inventory.

```text
 M .gitignore
 M agents/claude-code/.claude/agents/stnl-validation-runner.md
 M agents/codex/.codex/agents/stnl_validation_runner.toml
 M benchmarks/sentinel-todo/README.md
 D benchmarks/sentinel-todo/runtime/benchmark-agent-harness.mjs
 D benchmarks/sentinel-todo/runtime/benchmark-production-pilot.mjs
 D benchmarks/sentinel-todo/runtime/benchmark-rehearsal.mjs
 D benchmarks/sentinel-todo/runtime/benchmark-runner-broker.mjs
 D benchmarks/sentinel-todo/runtime/benchmark-runner-contract.mjs
 D benchmarks/sentinel-todo/runtime/benchmark-validation-runner.mjs
 M benchmarks/sentinel-todo/runtime/benchmark.mjs
 M maintenance/p0-evidence/s3-benchmark-simplification.md
 M scripts/check-contracts.mjs
 D scripts/test-benchmark-agent-harness.mjs
 M scripts/test-benchmark-contract.mjs
 D scripts/test-benchmark-production-pilot.mjs
 D scripts/test-benchmark-rehearsal.mjs
 M scripts/test-benchmark-runner-broker.mjs
 M scripts/test-execution-contract.mjs
 M scripts/test-launcher-contract.mjs
 M scripts/test-subagent-packages.mjs
 M scripts/test-validation-runner-contract.mjs
 M scripts/validate.sh
 M skills/workflows/stnl-execution-planner/SKILL.md
 M skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs
 M skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs
 M skills/workflows/stnl-plan-reviewer/SKILL.md
 M skills/workflows/stnl-slice-executor/SKILL.md
 M skills/workflows/stnl-slice-quality-manager/SKILL.md
 M skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/core.mjs
 M skills/workflows/stnl-spec-lifecycle-manager/runtime/test/core.test.mjs
 M skills/workflows/stnl-task-materializer/SKILL.md
 M skills/workflows/stnl-task-materializer/runtime/prepare-task-candidate.mjs
 M skills/workflows/stnl-task-materializer/runtime/serialize-task-paths.mjs
 M skills/workflows/stnl-task-reviewer/SKILL.md
 M templates/prompts/execution-plan-review.md
 M templates/prompts/execution-plan.md
 M templates/prompts/execution-replan.md
 M templates/prompts/execution-tasks.md
 M templates/prompts/slice-apply-findings-claude.md
 M templates/prompts/slice-apply-findings-codex.md
 M templates/prompts/slice-execute-claude.md
 M templates/prompts/slice-execute-codex.md
 M templates/prompts/slice-validate-claude.md
 M templates/prompts/slice-validate-codex.md
 M templates/prompts/spec-close.md
 M templates/prompts/spec-init.md
 M templates/prompts/spec-readiness.md
 M templates/prompts/spec-roadmap-init.md
 M templates/prompts/spec-roadmap-reconcile.md
 M templates/prompts/spec-test-runbook.md
?? agents/codex/package-lock.json
?? agents/codex/package.json
?? agents/codex/runtime/isolated-home.mjs
?? agents/codex/runtime/runner-broker.mjs
?? agents/codex/runtime/sdk-transport.mjs
?? agents/codex/runtime/validation-runner.mjs
?? benchmarks/sentinel-todo/runtime/benchmark-manager.mjs
?? benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs
?? scripts/test-benchmark-manager.mjs
?? scripts/test-codex-runner-adapter.mjs
?? skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs
?? skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs
```

## 2026-09-25 correction mission — in progress

The preceding statement that initial and terminal READINESS are required is **superseded** by the approved product flow. A valid INIT may be ready, draft, or blocked. Ready INIT advances to PLAN; draft or blocked INIT enters read-only GLOBAL READINESS and evidence-supported RESUME cycles. A material RESUME requires another GLOBAL READINESS. GLOBAL/READY on unchanged draft content permits the official status-only promotion; PLAN requires effective ready status. Official execution COMPLETE advances directly to CLOSE, without terminal READINESS or a mandatory CLOSE attestation. Historical v1 journals/raws retain their original interpretation.

Preflight for this mission confirmed branch `feature/atlas-p0`, required base HEAD `36d06341987b0e071602b2684e4ef268d0999040`, parent `9f9bd4a52becd78f4d4372dcd4d52ba22d97b971`, remote branch at the same SHA over HTTPS, clean functional tree, `git diff --check`, and no active campaign process. The SSH remote probe lacked a local key; HTTPS verified the publication. The historical 100/100 ledger and retained A/B/C run were present. The additive authorization changed only the ceiling to 180 and recorded six completed maintenance worker turns, numbers 101–106; the pre-live balance was 74. The principal session's platform usage is not exposed by this controllable-turn ledger and is reported separately as unmetered.

### Template responsibility migration, parent → base → current correction

The comparison is scoped to responsibility removed between parent `9f9bd4a` and base `36d0634`. Repeated instructions were grouped by owner. “Manual” means a normal launcher reaches the same installed skill/runtime path without the benchmark manager or fabricated `active.json`; it is an execution-path check, not a claim that every branch was exercised live in a standalone manual task.

| Responsibility removed | Nature | Destination / effective consumer | Manual? | Proof | Decision |
| --- | --- | --- | --- | --- | --- |
| PLAN preparation, authority read, candidate validation and publication | Procedure/mechanics | `stnl-execution-planner` skill and runtime; `execution-plan.md` supplies normal inputs | Yes | Planner/runtime handoff and execution contract tests; manager sends the versioned template | Keep out of launcher |
| Independent plan and task review | Separate role and verdict | `stnl-plan-reviewer` and `stnl-task-reviewer` skills, official review state | Yes | Skills invoke independent review; contract and materialization handoff tests | Keep independent |
| Task rebasing and path serialization | Candidate mechanics | `stnl-task-materializer` runtime, `prepare-task-candidate.mjs`, `serialize-task-paths.mjs` | Yes | Runtime tests and materialization contracts | Keep in runtime |
| File Purpose Headers and canonical sections | Document contract | Skill references and runtime validators/serializers | Yes | Distribution and execution/lifecycle validation | Keep in product authority |
| Runner invocation and capture | Platform transport/semantic evidence | Slice skills choose `STNL_RUNNER_ADAPTER` when configured, otherwise the installed independent `stnl_validation_runner`; `agents/codex/runtime/` adapter and serializer own broker/capture | Yes, via normal runner fallback | Installed agent registry, skill path, broker/adapter and execution contract tests; no manual `active.json` requirement | Keep normal fallback; benchmark supplies adapter only in isolated home |
| Auxiliary test rounds and authorized in-slice recovery | Workflow procedure | Slice executor skill and execution-state/producer runtime | Yes | Execution contract covers rounds and rejected candidate recovery | Keep in skill/runtime |
| Requirements authority, SPEC_PATH and context parameters | Authority/input | Versioned launcher parameters, lifecycle/execution skills, runtime preflight | Yes | Launcher grammar and exact rendered-prompt test; authority validators | Keep normal parameter grammar; multiline semantic input allowed |
| Candidate ownership and strict publication | Safety boundary | Lifecycle, planner, materializer, executor and quality-manager preparers/validators/publishers | Yes | Publisher/lifecycle and execution contracts, source/target identity checks | Keep product-owned |
| Findings, formal validation and effective base | Review authority | `stnl-slice-quality-manager`, official execution-state, validation publisher | Yes | Execution contract, independent runner response capture, Prior Validation Overlap guard | Keep formal validator independent |
| SPEC lifecycle and closing | Documentary authority | `stnl-spec-lifecycle-manager` modes/runtime; manager follows official handoff | Yes | Direct CLOSE builder/publisher tests and structured READINESS snapshot test | Apply approved INIT/READINESS/RESUME and COMPLETE→CLOSE flow |
| Roadmap and test runbook launcher detail | Adjacent entry parameters | Existing `stnl-spec-roadmap` and `stnl-spec-test-runbook` skills/runtime | Yes | Launcher/distribution contracts; no feature redesign | Retain existing owners |

| Issue | Cause | Decision and files | Proof before live |
| --- | --- | --- | --- |
| INIT/READINESS/RESUME and final CLOSE | Old manager/journal assumed fixed initial and terminal readiness | Structured snapshot-bound result in lifecycle runtime; manager schedules official handoffs; journal/result protocol v2 reads v1 unchanged; direct CLOSE in lifecycle builder/publisher | Lifecycle 154 pass, 1 environment skip; benchmark contract 12 pass; manager focused tests pass |
| C explanatory backticks | Schema accepted text but execution scalar parser rejected literal delimiters | Canonical `json:` plus JSON string for explanatory single-line values in mirrored serializers; technical fields stay strict | Execution contracts 119 pass, including C payload and malformed controls |
| Budget exhaustion and B/C concurrency | Runner start could occur without remaining global capacity | Serialized ledger reservations for main and mandatory runner, extra runner admission, confirmed-start accounting, administrative pause | Manager code review and focused tests; concurrent live B/C still pending |
| Cumulative usage | Retained SDK events increase on resumed threads | Per-thread/segment difference with known baseline, duplicate detection and separate runner source; partial/unavailable retained | Adapter tests and offline derived report |
| Human feedback | JSON-only delayed observation | Deterministic reporter with TTY/non-TTY/JSON modes and operation start/progress | Reporter 6 pass; live feedback in progress |

The old run's derived, non-destructive telemetry is `benchmark-temp/run-20260924210317-4bc02b11/derived-usage-v2.json`. Its 33 observed completions were all attributable from known per-thread starts: A 13,823,739 input / 97,780 output, B 7,846,637 / 83,157, C 10,777,598 / 80,134. Cached input and reasoning output are subcategories, not added again to total. These are SDK usage counters, not a charge or a comparable efficiency claim. Original raws and journals were not rewritten.

Pre-live checks: lifecycle runtime tests 154 pass, 1 skip; execution contracts 119 pass; benchmark contract 12 pass; `bash scripts/validate.sh --no-smoke` exit 0; `benchmark.mjs verify` exit 0; `git diff --check` exit 0. Workers: runner contract/telemetry, template audit/protocol/UI, and lifecycle CLOSE, each on GPT-5.6-Luna/medium in bounded files. Their patches were reviewed and integrated by the principal. No source stage, commit, or push occurred.

The fresh full run started through `node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --full` at `benchmark-temp/run-20260925191022-51497c69/`. Its frozen base is the required HEAD and the **functional** source identity is `sha256:6443cb7413b1df530117afe529e3f724f1d3315d0fd8943457bbc30fa7dd8554`; snapshot identity is `sha256:16365ff40811dea31d8163880db5852e298d0df6eb7f96c339528f4ae0a2f207` (277 functional source files, 294 with pinned dependencies). The working tree is intentionally uncommitted. This section records a run in progress, not a PASS claim.

### First fresh run result and bounded correction

`run-20260925191022-51497c69` ended with A `PASS`, B `BLOCKED`, C `BLOCKED`, on one immutable functional snapshot. A produced ready directly at INIT, passed PLAN/reviews/tasks, implemented and formally validated three slices, reached official `COMPLETE`, called `SPEC_CLOSE` immediately, and finalized `closed`/`PASS` with no READINESS event. Its cost was 12 main plus 7 runner turns. B published ready INIT, PLAN and tasks, but its first `EXECUTE_SLICE` ended `RUNNER_RESULT_BLOCKED` after 6 main and 1 runner turn. C completed the same preparation and its first implementation and formal validation, proving the C parser no longer rejects its semantic response; its second `EXECUTE_SLICE` ended `RUNNER_RESULT_BLOCKED` after 8 main and 3 runner turns. The run consumed 37 controlled turns, moving the ledger from 106 to 143/180. All raw results, rejected candidates, events, private-home cleanup records and diagnostics remain under the owned run; no blocked result was rewritten as PASS.

Both new blockers have one demonstrated cause class: the independent runner returned an invalid technical `head` for EXECUTE. B's semantic JSON had `TESTS_PASS`, executed commands, but `head` was explanatory text saying Git was unavailable; C's second runner returned `TESTS_PASS` with `head` empty. The deterministic producer/validator rejected the responses and the main contexts persisted delegation blockers without publishing false validation. Retained C first-runner events show that `git rev-parse HEAD` exited 0 and returned a valid 40-character SHA even though Apple Git emitted xcrun cache/FSEvents warnings on stderr; B had only inspected `git status` and misread those warnings as loss of HEAD. The distributed runner instructions previously said to capture HEAD only in `VALIDATE_SLICE`, despite the EXECUTE/APPLY semantic schema requiring it. This is the causal contract gap; it is not a reason to accept placeholders or relax sandbox permissions.

The correction changed the mirrored Codex and Claude runner contracts to obtain `git rev-parse HEAD` for EXECUTE/APPLY/VALIDATE and use a valid stdout SHA when exit is 0, while returning BLOCKED for a genuinely unavailable SHA. `scripts/test-validation-runner-contract.mjs` now guards the rule and the prior serializer/validator tests still reject malformed technical fields. The focused runner contract passed 113/113, execution contracts 119/119, repository `validate.sh --no-smoke` exited 0, `benchmark.mjs verify` exited 0, and `git diff --check` exited 0. The first run is diagnostic evidence for the previous snapshot only.

With 37 turns left, the principal froze a second revision and started a new `--full` run at `benchmark-temp/run-20260925203251-059fad36/`. Its functional source identity is `sha256:b282f3ec6c77b23ef3bc96777c270a134a6efc50323800048d6998b5b004c4ed` and snapshot identity is `sha256:cbdeb67272b029a1b0ceb2bf98f04b6597d8283c053ff2e40f1977e88d99bddf`. The manager's serialized ledger admits each operation only with capacity for its mandatory runner; a budget shortfall pauses before dispatch. No convergence is claimed while the second run is active.

### Second fresh run result, budget extension, and current corrections

The user explicitly authorized 30 more controllable turns during the second run. The ledger limit was atomically raised from 180 to 210 while both B/C INIT turns were active, preserving the prior +80 authorization and every historical turn. The manager subsequently read the new ceiling and continued the same immutable run. This was not a reset or per-case quota.

`run-20260925203251-059fad36` ended `BLOCKED` at 2026-09-25T21:42:30Z with one frozen functional revision. A passed all 10 main and 4 runner turns, implemented and formally validated two slices, reached official `COMPLETE`, went directly to `SPEC_CLOSE`, and finalized `closed` with finalizer exit 0. B passed ready INIT, planning, reviews, task materialization/review and its first `EXECUTE_SLICE`; the corrected runner HEAD contract yielded accepted `IMPLEMENTED_AWAITING_VALIDATION`. Its first `VALIDATE_SLICE` stopped with `OFFICIAL_TRANSITION_NOT_OBSERVED` after 7 main and 1 managed runner turns, leaving the live execution state unchanged. C passed the same setup but its first `EXECUTE_SLICE` ended `RUNNER_RESULT_BLOCKED` after 6 main and 1 managed runner turns. Its first product implementation and tests were retained, but no false official PASS was published. A/B/C raw v2 artifacts, candidate diagnostics, semantic responses and events remain in the owned run; the finalizer returned 0 only for A.

The C blocker is an evidence-copy defect distinct from the prior HEAD failure. The deterministic execution producer emitted a valid 64-character SHA-256 for `src/validation.mjs`, but the main context copied only 63 characters into its isolated candidate. Strict candidate validation rejected that draft. The main then mislabeled the transcription error as malformed runner output and persisted a delegation blocker. The source correction adds an owned-candidate-only `--insert-candidate` operation to the mirrored evidence producer, so canonical records and hashes are inserted mechanically. The executor instruction now requires this path, distinguishes producer/candidate failures from runner schema failures, and forbids manual digest transcription. A focused test proves exact insertion, live-byte preservation, duplicate rejection, live-target rejection, and strict candidate acceptance.

In B validation, the main context invoked a collaboration `spawn_agent` instead of the configured managed runner adapter. That child identified a real `priority: null` behavior defect, but returned keys and types outside the runner contract. No managed validation runner request was handled. The main built a valid `RUNNER_RESULT_BLOCKED` candidate, yet the validation publisher rejected the `Delegation Blocker` section because its ownership list omitted that legal blocked transition. The source correction sets `features.multi_agent=false` in the Codex SDK client, verified with the local Codex CLI feature override, so SDK main turns cannot initiate unbudgeted collaboration children; the configured adapter remains the only managed runner path. The validation publisher now permits `Delegation Blocker` changes only for a strictly validated blocked candidate or an existing blocker being resolved. A focused publisher test proves the blocked candidate can be published without changing unrelated sections.

The retained B events contain exactly one `spawn_agent` followed by completed `wait` and `close_agent`; no other collaboration spawn appeared in either fresh run. Because this child's generation was not admitted by the manager, the principal appended a reconciliation entry as turn 173, role `subagent`, without renumbering turns 1–172. Exact child start time and token usage are unavailable; the child is never treated as free. At this checkpoint the global ledger is 173/210, leaving 37. The v2 raw telemetry for the second run reports A 14,777,356 input / 90,194 output, B 8,407,174 / 78,705, C 8,199,634 / 85,163; B's untracked child's tokens are additional but unavailable. These are SDK counters, not billing. The root principal session is also not metered by this ledger.

Post-correction checks: execution contracts 121/121, validation-runner contracts 113/113, benchmark manager contracts 4/4, Codex runner adapter contracts 4/4, `bash scripts/validate.sh --no-smoke` exit 0, `benchmark.mjs verify` exit 0, and `git diff --check` exit 0. The next full-run proof requires a new functional snapshot; the previous A PASS cannot be combined with B/C from that new revision. The observed minimum normal path is about 46 controlled turns before plausible B findings recovery, exceeding the 37 remaining. A further explicit budget decision is pending; no new full run has started.

### Current correction-mission changed-file inventory

The 42 paths below are the complete uncommitted source/document inventory at this checkpoint. Ignored `benchmark-temp/` artifacts are separate. No source file was staged, committed, or pushed.

The current post-correction functional source identity (277 files) is `sha256:9cdce53ac598bd269b7f318415b074f2a446ebd7b78d6a4a3aba7bdd2724c678`. This identity has passed local checks but has **not** been exercised by a fresh full A/B/C run.

```text
 M agents/claude-code/.claude/agents/stnl-validation-runner.md
 M agents/codex/.codex/agents/stnl_validation_runner.toml
 M agents/codex/runtime/sdk-transport.mjs
 M benchmarks/sentinel-todo/benchmark.json
 M benchmarks/sentinel-todo/runtime/benchmark-manager.mjs
 M benchmarks/sentinel-todo/runtime/benchmark.mjs
 M maintenance/p0-evidence/s3-benchmark-simplification.md
 M scripts/check-contracts.mjs
 M scripts/lib/check-distributable-skill.mjs
 M scripts/test-benchmark-contract.mjs
 M scripts/test-benchmark-manager.mjs
 M scripts/test-codex-runner-adapter.mjs
 M scripts/test-execution-contract.mjs
 M scripts/test-launcher-contract.mjs
 M scripts/test-validation-runner-contract.mjs
 M scripts/validate.sh
 M skills/workflows/stnl-slice-executor/SKILL.md
 M skills/workflows/stnl-slice-executor/references/execution-record-schema.md
 M skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs
 M skills/workflows/stnl-slice-quality-manager/references/execution-record-schema.md
 M skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs
 M skills/workflows/stnl-slice-quality-manager/runtime/serialize-runner-evidence.mjs
 M skills/workflows/stnl-spec-lifecycle-manager/SKILL.md
 M skills/workflows/stnl-spec-lifecycle-manager/references/close-policy.md
 M skills/workflows/stnl-spec-lifecycle-manager/references/modes.md
 M skills/workflows/stnl-spec-lifecycle-manager/runtime/build-closed-spec.mjs
 M skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/closed-spec.mjs
 M skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs
 M skills/workflows/stnl-spec-lifecycle-manager/runtime/test/closed-spec.test.mjs
 M skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher.test.mjs
 M skills/workflows/stnl-spec-lifecycle-manager/runtime/test/readiness.test.mjs
 M skills/workflows/stnl-task-materializer/references/execution-record-schema.md
 M templates/prompts/spec-readiness.md
?? agents/codex/runtime/usage-accounting.mjs
?? benchmarks/sentinel-todo/runtime/benchmark-ui.mjs
?? benchmarks/sentinel-todo/schemas/journal-v2.schema.json
?? benchmarks/sentinel-todo/schemas/result-v2.schema.json
?? scripts/test-benchmark-ui.mjs
?? skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/readiness-result.mjs
?? skills/workflows/stnl-spec-lifecycle-manager/runtime/readiness-result.schema.json
?? skills/workflows/stnl-spec-lifecycle-manager/runtime/readiness-snapshot.mjs
?? templates/prompts/spec-readiness-local.md
```

## 2026-09-26 published-revision execution checkpoint

The branch was `feature/atlas-p0` at published HEAD `49a781ce68a934e1b21aa33423bf367eaa32c719` (parent `36d06341987b0e071602b2684e4ef268d0999040`). The functional tree was clean, `git diff --check` passed, and no run was active. The preserved turn ledger entered at 173/210 with no reservations. The user-authorized single +30 extension was recorded atomically in its existing `authorizedExtensions` history, setting the absolute ceiling to 240 without renumbering or resetting turns.

The first `run --full` tested that published SHA without a source edit: `benchmark-temp/run-20260926001304-f0ca1b00/`, functional identity `sha256:9cdce53ac598bd269b7f318415b074f2a446ebd7b78d6a4a3aba7bdd2724c678`, snapshot `sha256:ad3b195dfcdc16cd11389f2a3136f87912fda46302ac2667ebc17eb006ba270f`. Its collector summary is `BLOCKED`, not an A/B/C PASS. A is `PASS`: 10 operations, two executed and formally validated slices, official `COMPLETE`, direct `SPEC_CLOSE`, closed SPEC, finalizer exit 0, and final `node --test` exit 0. B and C each passed `SPEC_INIT` as draft, then stopped at `SPEC_READINESS` before a model response. Both retained event streams report provider HTTP 400 `invalid_json_schema`: property `version` lacked a `type` in the structured READINESS output schema. Their finalizers exited 1; neither reached PLAN, execution, or closed SPEC. This full consumed 18 controlled turns (A 10 main/4 runner; B and C 2 main each) in 36m59s. The case states report integrity `PASS` and removed terminal private homes.

The causal patch adds explicit types for the five `const`/`enum` fields of `skills/workflows/stnl-spec-lifecycle-manager/runtime/readiness-result.schema.json`; it preserves the deterministic result validator. A focused schema regression requires explicit types, complete required fields, and closed objects. `scripts/test-benchmark-manager.mjs` passed 5/5, lifecycle `readiness.test.mjs` passed 10/10, and `git diff --check` passed. [Official OpenAI Structured Outputs guidance](https://developers.openai.com/api/docs/guides/structured-outputs) requires typed fields and all object fields to be required.

Two managed two-operation focal runs tested the patched revision `sha256:ffe6d72b86c65812507f9d7ac53eec046c36a4b25934b8da2c9829e1bd5bbf4c` with snapshot `sha256:8c71da2c84df55214ab44eb745160929fbb7f737013320cd93be8bd54230c6e3`: B at `benchmark-temp/run-20260926005150-8c495755/` and C at `benchmark-temp/run-20260926005735-4a6b7431/`. Both legitimately produced ready INIT, passed PLAN, and stopped at the configured `FOCAL_STOP`. They did not invoke READINESS; therefore they do not prove live provider acceptance of the patch and cannot be combined with A from the prior full snapshot. Each cost 2 main turns. Their suspended private homes retain session state with `auth.json` absent; run artifacts remain preserved.

The mission spent 22 controlled turns (18 full, 4 focal), taking the ledger to 195/240 with 45 available and no reservations. No maintenance workers were used. The root maintainer session is not metered by this ledger. Normalized SDK usage attributable to completed operations across these runs is 15,969,429 input and 141,941 output tokens, including the four A runners once; the two failed READINESS turns have unavailable usage, so coverage is partial. Cached input and reasoning output are subcategories, not added again, and these counters are not subscription charges. All runs used `production-v2`, ChatGPT authentication, provider `openai`, restricted filesystem isolation, and no collaboration tool calls outside the managed runner adapter. Source status after the runs contains only this report, the causal schema patch, and its regression.

Mission status: `PAUSED_LOCAL_BUDGET`. The patched revision has no same-snapshot full A/B/C proof. The remaining 45 turns are below the prior approximately 46-turn normal full path even before any legitimate B finding recovery. The official baseline is `NOT_YET_ESTABLISHED`, G6 remains `NOT_YET_PROVEN`, G2/G3 remain `PARTIAL`, and P0 remains open. The next necessary action is an explicit budget decision sufficient for a new full run of one patched functional revision; no further run, commit, or push was made here.

## 2026-09-25–26 final A/B/C closure mission

Preflight confirmed branch `feature/atlas-p0`, published HEAD `e95e160aab664e031ca14566e44e143be5c7a404`, parent `49a781ce68a934e1b21aa33423bf367eaa32c719`, matching remote branch, clean functional tree, no active benchmark, and `git diff --check` PASS. The ledger entered at 195/240 with no reservations. The user's single +60 authorization was appended to the existing `authorizedExtensions` history, setting the absolute ceiling to 300 without resetting any turn or number. The root maintainer session is not measured by this ledger.

The live READINESS schema handshake used the published `readiness-result.schema.json`, the pinned `@openai/codex-sdk` transport, provider `openai`, isolated ChatGPT authentication, GPT-5.6-Luna/medium, and an owned temporary workspace. The provider accepted `outputSchema`; the returned object validated against the schema. Status `PASS`, thread `01a0db74-2145-7691-b8cd-2bdf7ebc7077`, ledger turn 196, SDK usage 8,131 input / 92 output (0 cached input; 18 reasoning output included in output). The retained summary is `benchmark-temp/schema-handshake-10a236fd/result.json`; no response body, event stream, or credentials were retained. The ledger is 196/300 before the first full run.

First fresh full: `benchmark-temp/run-20260926020401-c6d5e35e/`, published base `e95e160aab664e031ca14566e44e143be5c7a404`, functional identity `sha256:ffe6d72b86c65812507f9d7ac53eec046c36a4b25934b8da2c9829e1bd5bbf4c`, snapshot `sha256:8c71da2c84df55214ab44eb745160929fbb7f737013320cd93be8bd54230c6e3`. Result `BLOCKED` after approximately 22m28s. A passed INIT, PLAN, REVIEW_PLAN, MATERIALIZE_TASKS, and REVIEW_TASKS, then its first `EXECUTE_SLICE` published official `RUNNER_INITIALIZATION_BLOCKED`; A remained ready/open with incomplete execution. B/C were `NOT_RUN` under the A gate. The run used 6 main turns, 0 runner turns, and ended at 202/300 (98 available). A final `node --test` exited 0, profile mismatches were empty, snapshot/source integrity passed, and finalizer retained `BLOCKED` in `case-a/raw.json`; no result was promoted to PASS.

The failing operation is retained in `case-a/06-execute_slice.json`, its exact prompt and event stream, official readback, workspace and rejected candidate, `case-a/raw.json`, and `summary.json`. Both attempted direct `spawnSync` execution of the managed adapter returned exit 1 with empty output; the managed broker handled zero requests and no runner turn started. This is an adapter invocation boundary failure, not a check result. Causal maintenance is in progress only after the full terminated; the published snapshot and raws remain untouched.

Causal local diagnosis reproduced the exact direct `spawnSync(adapter, args)` form against the frozen adapter: the 0444 mode returned `EACCES`, null process status, and no streams before broker IPC. The minimal patch makes `agents/codex/runtime/validation-runner.mjs` executable (Git mode 100644 → 100755), retains executable mode as 0555 when freezing a snapshot, and tests direct adapter execution plus frozen-mode mapping. The already published snapshot remains intact at 0444. The GPT-5.6-Sol/xhigh maintenance principal used one ledger turn (203); no maintenance workers or live replays were used. Focused adapter, broker, and manager suites passed 17/17; `git diff --check` passed. Ledger before the second full: 203/300, with 97 available and no reservations. This local proof covers the OS launch failure; the authorized second full must prove the runner end to end on the new snapshot.

The second and last authorized fresh full ran at `benchmark-temp/run-20260926023226-012359e2/` for 1h11m42s. It froze base SHA `e95e160aab664e031ca14566e44e143be5c7a404` plus functional diff `sha256:9156ef49d5977a6c87250cf4633cb1841944eeb66cff0db8413d384dc9872f1c`, source functional identity `sha256:039b1e3c09bbb2a8fd1fb5d23ff5337d33d57f5da4a2b3a21b2443fb9b6b3fce`, and snapshot `sha256:5055058f5afa5282706f77ac9dc6fa90b9b70e9a1dda91e430f23ace2f63ac3a`. The frozen adapter was 0555. No source edit or maintenance worker occurred during the run.

Case A passed all 10 operations with 10 main and 4 managed runner turns: two slices implemented and formally validated, official `COMPLETE`, immediate `SPEC_CLOSE`, closed SPEC, final tests PASS, finalizer exit 0, and no terminal READINESS. The formerly failing runner launch boundary worked on the new snapshot. Case B passed INIT through formal validation of slice 01, then its slice 02 runner returned an initial legitimate `TESTS_FAIL` followed by two `TESTS_PASS` results after correction. Its candidate `implementation-check-01` lacked required file-backed `Correction paths`; strict candidate validation rejected it, no slice 02 execution evidence was published, official state stayed `EXECUTION_STARTED`, and the finalizer retained `OFFICIAL_TRANSITION_NOT_OBSERVED`. B used 8 main and 5 runner turns. Case C passed INIT through task review, then its first slice runner returned semantic `BLOCKED`: the request exposed conflicting `RUNNER_EVIDENCE_SERIALIZER` paths (snapshot path versus inaccessible private skill path). The runner's empty `head` also failed deterministic serialization; the rejected candidate and recovery candidate are preserved, and official readback published `RUNNER_RESULT_BLOCKED`. C used 6 main and 1 runner turn. B/C remained ready/open and did not reach COMPLETE or CLOSE. Their raw finalizers exited 1. All three final `node --test` commands exited 0, profile mismatches were empty, source/snapshot integrity was PASS, ChatGPT/openai/restricted isolation passed, private homes were removed, and event streams contain no unmanaged collaboration calls. The second full is `BLOCKED`, not an A/B/C PASS.

Second-full normalized SDK usage covers all 24 main operations and 10 managed runner turns once: 31,625,720 input and 259,893 output tokens (29,733,760 cached input and 81,564 reasoning output are included subcategories). First-full usage covered 6/6 main operations, 0 runner: 6,256,548 input and 63,222 output. The handshake used 8,131 input and 92 output. Combined measured mission SDK usage is 37,890,399 input and 323,207 output, with complete available operation coverage; these counters are not billing. The maintenance principal and root maintainer session do not expose comparable token usage. The second full consumed 34 turns, so the mission used 42 controlled turns total (1 handshake, 6 first-full main, 1 maintenance principal, 24 second-full main, 10 second-full runner). The single ledger ended at 237/300 with 63 available and no reservations.

Mission result: `BLOCKED_AFTER_TWO_FULL_RUNS`. Both authorized full runs and the one causal local patch are complete. The new B evidence-producer contract failure and C runner-context conflict require a separate strategy decision; no third full or further source patch is authorized in this mission. The official A/B/C baseline is still `NOT_YET_ESTABLISHED`; G6 remains `NOT_YET_PROVEN`, G2/G3 remain `PARTIAL`, and P0 remains open. No commit or push was made. All original and new raws remain unchanged.

## B/C focal boundary correction

Entry reconciliation: the expected `e95e160aab664e031ca14566e44e143be5c7a404` is now the parent of published branch/remote HEAD `ada5395bbc5ec6140be5d1b27048e59d3bfe7722`. That commit contains exactly the prior mission's documented executable-adapter/snapshot-mode patch and its tests/report; the working tree entered clean, `git diff --check` passed, and no benchmark was active. The unchanged historical full evidence remains `run-20260926023226-012359e2`.

B cause: `case-b/08-execute_slice.json` reached a second-round `TESTS_PASS` after a first-round `TESTS_FAIL`. The semantic response contained a valid `correctionApplied`, but the candidate retained `Corrections Applied: none`. The producer copied that empty section into `Correction paths: none`; `--insert-candidate` preserved the incorrect field, and strict validation rejected `implementation-check-02 file-backed Correction paths cannot be none`. The first loss was the candidate's correction section, not the runner response. The executor/quality-manager mirrored producer now compares the immediately preceding canonical failing `Tested state` with current approved physical targets, fills an empty candidate `Corrections Applied` mechanically, rejects explicit mismatched claims, and derives `Correction paths` from the canonical section. Round one remains without historical correction fields. A focused real-runtime regression proves round-two bundle → `--insert-candidate` → strict candidate PASS, wrong-path/missing-evidence rejection, and byte-identical live task during rejected candidate production.

C cause: `case-c/06-execute_slice.json` and the main event stream show two distinct serializer paths in the runner request: the main skill sent a private installed-skill path, and the adapter supplied the frozen snapshot path. The runner returned semantic `BLOCKED`, and official readback ended at `RUNNER_RESULT_BLOCKED`. The executor skill now keeps its local serializer path for candidate persistence and omits it from the delegated payload. The adapter remains the sole snapshot serializer authority and rejects a competing prompt path before dispatch. A composed-request regression verifies one serializer assignment from the snapshot, coherent operation/SPEC/slice context, and rejection of the former private-skill path.

Two GPT-5.6-Luna/medium maintenance workers owned disjoint B and C filesets, used one ledger turn each, and returned `PATCH_READY`; neither ran a live model or changed the budget. Focused execution, runner/adapter, broker, and manager contracts passed 251/251 before the final added insertion regression; the complete execution contract then passed 122/122 with that regression. `bash scripts/validate.sh --no-smoke`, `benchmark.mjs verify`, and `git diff --check` passed. No live focal was needed because both properties were proved deterministically. Pre-full ledger is 239/300, no reservations, 61 available. The final full is pending; functional diff at this gate is `sha256:d408c1f1fb1883f1d18fd1ca8c69d2cb0516c1370d40dc920087679a30f1bf57` over published HEAD `ada5395bbc5ec6140be5d1b27048e59d3bfe7722`.

The mission's one and only fresh final full was `benchmark-temp/run-20260926124158-af312644/`, from 12:41:59 to 13:51:29 UTC (1h09m30s). Its frozen snapshot is `sha256:b2fd0dd0a04a190db1e40a511ae4c7e636f486d5a609d1697091bdba8739bdba` and source identity is `sha256:ae41128d373935f73357049cc16192a0b38ba44608329070d0787a1b3ab3b1c3`, with the pre-gate functional diff above. A passed 8 main and 2 runner turns, reached `COMPLETE`, immediately executed `SPEC_CLOSE`, and closed. B passed 12 main and 9 runner turns, reached `COMPLETE`, immediately closed, and its slice-02 first-round `TESTS_FAIL` → second-round `TESTS_PASS` persisted `Correction paths: ../../../../src/cli.mjs` from canonical `Corrections Applied`; strict validation and the following formal validations passed. C passed `EXECUTE_SLICE slice-01` with one managed runner, proving the serializer conflict was removed, but its next `VALIDATE_SLICE slice-01` blocked before runner dispatch. The exact launcher prompt and official preflight used the existing `benchmark-temp/run-20260926124158-af312644/case-c/workspace/specs/benchmark-case-c`, whereas the main context called `validate-execution-state.mjs` with the nonexistent `benchmark-temp/run-20260926124158-af312644-c-rHg93s/case-c/workspace/specs/benchmark-case-c`, transcribing the private-home suffix into the run path. That command returned exit 1; the main returned BLOCKED, official readback stayed `IMPLEMENTED_AWAITING_VALIDATION`, and the finalizer retained `OFFICIAL_TRANSITION_NOT_OBSERVED`. This is a new main-context path handoff defect in formal validation, separate from B's correction producer and C's runner serializer duplication. No further run, source correction, or campaign was started.

Final result: `BLOCKED_AFTER_FINAL_FULL` (A PASS, B PASS, C BLOCKED). The full used 39 turns (27 main, 12 runner), taking the mission from 239/300 to 278/300; with the two maintenance workers, this mission used 41 turns from 237/300 and has 22 available, no reservations. Normalized SDK usage covers all 27 main and 12 runner turns once: main 31,675,356 input / 243,842 output, runner 1,213,900 input / 24,531 output, combined 32,889,256 input / 268,373 output. Cached input and reasoning output are included subcategories; worker/root maintainer usage is unavailable and these counters are not billing. All three cases used `production-v2`, ChatGPT/openai restricted isolation, had zero profile mismatches, final `node --test` exit 0, snapshot/source integrity PASS, and no unmanaged collaboration event; A/B finalizers exited 0, C finalizer exited 1 truthfully. The baseline remains `NOT_YET_ESTABLISHED`, G6 `NOT_YET_PROVEN`, G2/G3 `PARTIAL`, and P0 open. Next decision: scope a separate focal correction for the C `VALIDATE_SLICE` path handoff before any future full; this mission cannot rerun.

## C managed validation path handoff

Published entry was `7863ec501417763371f9c35dc131a6e5fc9c5db4` (parent `ada5395bbc5ec6140be5d1b27048e59d3bfe7722`), matching `origin/feature/atlas-p0`, with a clean functional tree and no active run. The retained C event stream from `run-20260926124158-af312644` shows the correct launcher and manager preflight path, followed by a main-context command that inserted the private-home suffix `-c-rHg93s` into the run root. The installed skill path exposed that suffix; the skill's requirement to manually repeat preflight required a fresh model-authored path. The defect was the model-dependent transport of an already validated mechanical identity.

The bounded change gives managed `VALIDATE_SLICE` a manager-derived context containing canonical SPEC/workspace, operation, slice, and official state/fingerprint/legal identity. The manager checks its rendered launcher before dispatch; a pathless quality-manager helper verifies freshness from that context, explicit helper arguments must agree, and the runner adapter supplies its own official SPEC path. Manual launches retain the original preflight. One GPT-5.6-Luna/medium worker produced the initial patch for one ledger turn; principal integration preserved the repository's byte-identical shared runtime/serializer invariant. Regressions cover private-home suffix contamination, launcher/context disagreement, manual fallback, runner identity, both candidate preparers, pathless preflight, stale authority, and source/sibling containment. Focused suites passed 22/22, 122/122, and 113/113; `validate.sh --no-smoke`, benchmark `verify`, and `git diff --check` passed. No focal live run was used. The existing ledger was extended once from 300 to 350; the worker moved consumption from 278 to 279, leaving 71 before the only full.

The single full `benchmark-temp/run-20260926144046-e68b1246/` ran 14:40:47–15:00:08 UTC on base HEAD `7863ec5`, functional diff `sha256:75da4288e438cd5e8090fa2372613e82fadb9cc9c8e48e26b05f77a76e1a9624`, source identity `sha256:af6161e76039304f5e9b30f7760ffada780ee26145160cd52955fbd605671ef5`, and frozen snapshot `sha256:80595b8f4a17a29458a59d9162064fc656cd7c49e185aa43848d548feb8abd82`. A passed INIT, PLAN, reviews, and task materialization, then blocked at `EXECUTE_SLICE slice-01` with `RUNNER_INITIALIZATION_BLOCKED`; B/C were `NOT_RUN` under the A gate. A's environment exposed the correct `STNL_RUNNER_ADAPTER` under the frozen run snapshot, but the main context twice invoked a nonexistent runner path with the private-home suffix `-a-ghmEkk` appended to the run ID and also placed that suffix in a runner payload `specPath`. Node returned `MODULE_NOT_FOUND`; broker requests and runner turns remained zero. This is the same architectural mechanical-handoff class at a different operation, not proof against the local C fix. The full used 6 main / 0 runner turns, ending at 285/350 with 65 available and no reservations. A's final `node --test` passed, finalizer exited 1 truthfully, profile mismatches were empty, integrity passed, ChatGPT/openai restricted isolation held, and the private home was removed. SDK usage covers all six main turns once: 5,581,573 input / 52,756 output (5,234,048 cached input and 15,251 reasoning output are included); runner usage is zero because no runner started, while worker/root usage is unavailable. No second full or post-run source patch was made. Status is `BLOCKED_ARCHITECTURAL_HANDOFF_CLASS`; baseline remains `NOT_YET_ESTABLISHED`, G6 `NOT_YET_PROVEN`, G2/G3 `PARTIAL`, and P0 open. The next decision is whether to extend manager-owned mechanical identity transport to the `EXECUTE_SLICE` runner invocation boundary before any separately authorized campaign.

## Managed slice mechanical handoff

The retained `run-20260926144046-e68b1246` evidence proved that the manager and isolated environment held the correct snapshot adapter and canonical SPEC, but the main model reconstructed both from the suffixed private home before `EXECUTE_SLICE`. The focal refactor replaces the validation-only context with one `managed-slice-context` contract for `EXECUTE_SLICE`, `APPLY_FINDINGS`, and `VALIDATE_SLICE`. The benchmark manager creates it from the official preflight before budget admission; it transports canonical SPEC/workspace, normalized operation/slice, state, requirements authority, legal operations, mandatory recovery, and exact frozen snapshot adapter/bridge/preflight identities. The managed preflight rechecks current official state and file identity, and disagreement or staleness fails before runner dispatch.

The product-owned `managed-runner-bridge` takes no model-authored identity arguments. It reads the verified context, enforces the canonical workspace and snapshot adapter, preserves the semantic stdin payload byte-for-byte, and submits it to the existing broker. The adapter derives execution/plan/task paths and supplies the complete mechanical envelope. Manual launches remain valid when `STNL_MANAGED_CONTEXT` is absent and continue through the configured adapter contract. The common runtime is bundled byte-identically in the executor and quality-manager packages to preserve self-contained distribution.

Two GPT-5.6-Luna/medium workers owned disjoint runtime and regression/documentation filesets, used ledger turns 286–287, and returned `PATCH_READY`; neither ran a live model, changed budget, committed, or pushed. Regressions cover all three managed operations, launcher/context spec/workspace/operation/slice disagreement, stale identity, adapter/env disagreement, live-source/Main/sibling paths, private-home collision, semantic payload preservation, manual fallback, and pre-admission failure. Focused suites passed 27/27, execution contracts 123/123, validation-runner contracts 113/113, and subagent packaging 23/23. `bash scripts/validate.sh --no-smoke`, `node benchmarks/sentinel-todo/runtime/benchmark.mjs verify`, and `git diff --check` all pass. No focal live turn was needed because the mechanical boundary is exercised with the real runtimes locally.

Pre-full gate: published HEAD `79d2723ac90f0bb65c44cb861e65b735e9a18e51`, parent `7863ec501417763371f9c35dc131a6e5fc9c5db4`, functional diff `sha256:114327ea241358bbae44ee56e2fa7503be8f71be2cd9c6f24675be9adeacbc25`, source functional identity `sha256:2813ae29158db88c20e52403de8782bb0559cec33333fe0a7d5fbdd8d01ed43d` over 282 files, ledger 287/350 with 63 available and no reservations, zero active workers, and no active run marker. The mission's one full and its frozen snapshot/result are pending at this checkpoint.

The mission's single full was `benchmark-temp/run-20260926155001-ffd33b72/`, from 15:50:01 to 16:10:24 UTC (20m22s). It froze snapshot `sha256:ed5b69d41880b9fc19e34d5976506b8cfd87a2a69f433b518a0a766c33c88a46` with the pre-gate functional diff/source identities above (282 functional files, 299 including pinned dependencies). A passed INIT, PLAN, plan review, task materialization, and task review. Its first managed `EXECUTE_SLICE slice-01` then invoked the pathless bridge with a semantic-only JSON object; the broker handled one request and started one independent runner from the exact frozen snapshot adapter. The previous `MODULE_NOT_FOUND`/private-home reconstruction class did not recur.

The independent runner nevertheless returned semantic `BLOCKED` without running discovery or verification commands, stating that the configured executor instructions were inaccessible under its filesystem policy. It emitted an empty `head`, so the deterministic evidence serializer correctly rejected the result; the main context persisted one active malformed-output delegation blocker and official state `RUNNER_RESULT_BLOCKED`. A used 6 main and 1 runner turn, final `node --test` passed, finalizer exited 1 truthfully, and A did not reach COMPLETE/CLOSE. B and C were `NOT_RUN` under the A gate. This is a different post-dispatch runner instruction/access boundary, not persistence of the mechanical identity handoff class. Per the one-full rule, no source correction or second full was attempted.

The full moved the ledger from 287 to 294/350: 6 main and 1 runner turn, leaving 56 with no reservations. Combined with the two workers, this mission used 9 turns from the expected 285 entry. Normalized full usage covers all 6 main and 1 runner completions once: main 6,598,797 input / 51,905 output; runner 14,817 input / 831 output; combined 6,613,614 / 52,736. Cached input (6,239,488) and reasoning output (15,032) are included subcategories, not additional totals or billing. Worker/root-maintainer usage is unavailable. Production-v2, ChatGPT/openai, restricted isolation, zero profile mismatch, zero unmanaged collaboration, source/snapshot integrity, private-home removal, final tests, and truthful raw preservation all held.

Mission result: `BLOCKED_AFTER_FINAL_FULL`. The focal mechanical handoff is demonstrated at the live EXECUTE boundary, but A/B/C convergence was not obtained. Baseline remains `NOT_YET_ESTABLISHED`, G6 remains `NOT_YET_PROVEN`, G2/G3 remain `PARTIAL`, and P0 remains open. The single next decision is whether to authorize a separate correction for the independent runner's configured-instruction/filesystem-access boundary; this mission does not recommend or authorize another full.
