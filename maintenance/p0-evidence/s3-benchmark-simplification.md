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
