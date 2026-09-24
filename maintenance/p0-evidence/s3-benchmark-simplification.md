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
