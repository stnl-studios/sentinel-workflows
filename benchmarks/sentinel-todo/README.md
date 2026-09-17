# Sentinel Benchmark v1

`sentinel-todo` is a small, permanent, dependency-free benchmark fixture for
measuring raw Sentinel workflow behavior. It is engineering infrastructure, not
requirements authority, runtime authority, execution authority, or an implicit
context source for any skill.

The benchmark lifecycle runtime does not select a model or orchestrate the
workflow. External model turns pass through the separate, versioned Benchmark
Agent Harness v1; callers still drive Sentinel and record each observed
operation immediately in the external journal.

## Layout and isolation

- `seed/` is the original Todo CLI copied for every Case.
- `cases/` contains complete behavioral requirements sources, not prewritten
  SPECs or technical designs.
- `benchmark.json` owns the reproducible Production Profile, fixed SPEC paths,
  budgets, run modes, and schema versions.
- `runtime/benchmark.mjs` prepares workspaces, records a journal, enforces
  budgets, collects raw facts, and compares results.
- `runtime/benchmark-agent-harness.mjs` is the only authority for external
  provider discovery, model invocation, isolation, timeout, and JSONL parsing.
- `schemas/` documents the journal and result JSON contracts.

Every prepared workspace contains only the seed files, the selected Case as
`requirements.md`, and an empty `specs/` parent directory. It never receives the
manifest, schemas, budgets, profile, prior results, evidence, rubric, or
expected answers. Cases are independent:

```text
seed -> A
seed -> B
seed -> C
```

The fixed paths are `specs/benchmark-case-a`,
`specs/benchmark-case-b`, and `specs/benchmark-case-c`. The selected SPEC path
must not exist after `prepare`; only its empty parent is prepared so lifecycle
INIT can create the destination directly.

## Production Profile v2 (current)

| Phase | Case A | Case B | Case C |
| --- | --- | --- | --- |
| SPEC | Sol / high | Terra / high | Sol / high |
| PLAN | Terra / high | Terra / high | Sol / high |
| TASKS | Terra / high | Terra / high | Terra / high |
| EXECUTE / APPLY_FINDINGS | Luna / high | Luna / xhigh | Luna / xhigh |
| REVIEW / VALIDATE | Luna / high | Luna / xhigh | Luna / xhigh |

Production Pilots #1–#3 remain historical `production-v1` records; this table is
the current definition for the next Pilot. The journal stores actual dispatches. A difference from this expected profile is
preserved as a mismatch; the runtime never silently substitutes a model or
effort. `SPEC_INIT` and `SPEC_CLOSE` use the `SPEC` phase, while read-only
`SPEC_READINESS` uses `REVIEW_VALIDATE`.

## Commands

All paths supplied for workspaces, journals, and results are absolute. Paths with
spaces and Unicode are supported.

```text
node benchmarks/sentinel-todo/runtime/benchmark.mjs verify
node benchmarks/sentinel-todo/runtime/benchmark.mjs doctor
node benchmarks/sentinel-todo/runtime/benchmark.mjs prepare --case A --output <absolute-absent-path>
node benchmarks/sentinel-todo/runtime/benchmark.mjs journal-init --output <absolute-journal.json> --case A --sentinel-sha <sha> --run-mode case --production-profile production-v2
node benchmarks/sentinel-todo/runtime/benchmark.mjs journal-event --journal <absolute-journal.json> --operation PLAN --phase PLAN --model GPT-5.6-Terra --effort high --result PASS
node benchmarks/sentinel-todo/runtime/benchmark.mjs finalize --workspace <absolute-workspace> --case A --spec <absolute-spec-path> --journal <absolute-journal.json> --output <absolute-result.json>
node benchmarks/sentinel-todo/runtime/benchmark.mjs compare --before <absolute-result.json> --after <absolute-result.json>
node benchmarks/sentinel-todo/runtime/benchmark-agent-harness.mjs check
node benchmarks/sentinel-todo/runtime/benchmark-agent-harness.mjs run --request <absolute-request.json>
```

`doctor` is the offline Benchmark Environment Qualification v1 preflight. It
uses only Node built-ins and the installed Git executable, emits one sanitized
JSON line, and returns `0` for `ENVIRONMENT_READY`, `1` for
`ENVIRONMENT_BLOCKED`, or `2` for invalid invocation. An optional
`--scratch-parent <absolute-existing-path>` lets deterministic tests select an
outside-checkout parent; the doctor creates and removes only its own child.
The command never calls a provider or model and is not a benchmark metric.

`benchmark-agent-harness.mjs check` performs no model call. It discovers the
installed Codex CLI surface and emits a sanitized capability fingerprint.
`run` accepts exactly one strict request containing `model`, `effort`,
`sandbox`, `cwd`, `tmpdir`, `prompt`, and `timeoutMs`; it starts exactly one
model turn and never retries. The request file is transport into the harness;
the provider receives the prompt byte-for-byte through stdin.

Harness v1 accepts only GPT-5.6-Luna, GPT-5.6-Terra, and GPT-5.6-Sol; efforts
`low`, `medium`, `high`, and `xhigh`; and sandboxes `read-only` and
`workspace-write`. CWD must be a canonical real directory under the managed
session `workspaces/`, while TMPDIR must be that session's canonical
`runner-tmp`. Unknown values fail closed without starting a provider process.

The Codex adapter uses explicit model, effort, sandbox, approval, and CWD
settings; ephemeral state; ignored user config and rules; disabled project
instruction discovery; a minimal process environment; structured JSONL; and a
harness-owned wall-clock timeout and output bound. It distinguishes provider
initialization, timeout, protocol, and model-turn failures from Sentinel
outcomes. Public summaries do not expose absolute paths, credentials, the
process environment, or provider logs.

## Environment preflight and managed temp

Every Production Pilot starts, in order, with benchmark `verify`, seed tests,
benchmark contracts, required execution contracts, the environment `doctor`,
the agent harness `check`, and one GPT-5.6-Luna / medium sandbox probe launched
through Benchmark Agent Harness v1. Case A may start only after
`BENCHMARK_ENVIRONMENT_READY` and `BENCHMARK_AGENT_HARNESS_READY` and all other
mandatory checks pass. The sandbox probe is precondition evidence and does not
promote any P0 gate.

Each benchmark session owns a unique OS-temp-derived, realpath-canonicalized
root outside this checkout with these children:

```text
SESSION_ROOT/
  workspaces/
  journals/
  results/
  runner-tmp/
```

Processes that may create temporary files—including operation agents,
validation runners, Node tests, and helpers—receive `runner-tmp` as `TMPDIR` in
their process environment. They must inherit it; commands inside an agent do
not redefine it. The policy never changes the user environment, shell profile,
or global Git configuration. A session cleans only paths it created, fails
closed on cleanup failure, and never persists the real session path.

Requalify the environment after a host, OS, architecture, relevant Node or Git
change; a doctor contract, sandbox mechanism, validation-runner environment
adapter, or TMPDIR policy change; or any environment-related Pilot blocker.
Run the doctor for every future Pilot. Requalify the harness after the provider
CLI version or capability fingerprint, harness contract, model/effort/sandbox
mapping, config isolation, prompt transport, or structured-output protocol
changes. Run the Luna probe before the first Case of a new
qualification/session, whenever either fingerprint or the sandbox mechanism
changes, or after an environment/harness blocker.

`prepare` rejects an existing target and any target inside this checkout. It
copies regular seed files byte-for-byte, rejects symlinks, runs `node --test`,
creates a local Git repository, configures identity only in that repository,
creates one baseline commit, and verifies a clean working tree. Its `contentHash`
is SHA-256 over sorted normalized relative paths, file lengths, and file bytes;
`.git` and ignored OS metadata are excluded.

The seed, each requirements source, and each prepared fixture hash are pinned in
the manifest. Preparation happens in an owned sibling stage and is atomically
renamed to the requested target only after hashes, tests, local Git configuration,
baseline commit, and cleanliness pass. Git provider variables and global/system
configuration are excluded for these fixture-local commands; signing is disabled
and an empty local hooks path is used.

`verify` validates structure and configuration only. The cheap repository
contract suite separately runs the seed tests and prepare/finalize/compare
smokes. None of these commands runs a model benchmark.

## Workflow protocol

A complete Case is driven externally in this order:

```text
requirements
  -> SPEC lifecycle INIT
  -> READINESS when required
  -> PLAN
  -> REVIEW_PLAN
  -> MATERIALIZE_TASKS
  -> REVIEW_TASKS
  -> EXECUTE_SLICE
  -> VALIDATE_SLICE
  -> APPLY_FINDINGS only for real findings
  -> VALIDATE_SLICE again
  -> next slice
  -> execution state COMPLETE
  -> lifecycle READINESS with GLOBAL scope
  -> lifecycle MODE=CLOSE
  -> result
```

There is no execution `CLOSE`. Journal operation `SPEC_CLOSE` means lifecycle
`MODE=CLOSE`. Zero findings is a valid run.

Run modes are `focal` for an explicitly selected subset, `case` for one complete
Case, and `full` for three externally coordinated Case runs. The runtime does not
create a multiprocess or model orchestrator.

For Production Pilot and pre-pilot rehearsal drivers, a valid runner `BLOCKED`
result is terminal for the current Case. The driver persists exactly one
logical operation and its one check result, accepts the resulting
`AUXILIARY_BLOCKED` state, and stops without automatic same-operation re-entry
or consumption of rounds `2/3` and `3/3`. The official runtime may continue to
advertise a later manual same-operation recovery after the external cause is
resolved; that recovery legality is not an automatic benchmark retry.

## Journal and budgets

The journal is an explicit JSON file outside the prepared workspace and SPEC.
It is single-writer in v1. Events have sequential indexes and record operation,
profile phase, actual model, actual effort, result, and optional slice, round,
resulting state, duration, byte counts, token telemetry, observable reads,
retries, mechanical rejections, escalations, and child dispatches. Child
dispatches remain attached to their parent and do not inflate workflow operation
totals.

Budget enforcement counts attempted events. The event that exceeds a limit is
persisted, the journal becomes terminal `ABORTED_BUDGET`, a machine-readable
reason is stored, and `journal-event` exits with code `3`. No automatic retry is
performed and later events are rejected.

## Collection rules

`finalize` is read-only over the workspace, SPEC, execution artifacts, and
journal. Its only side effect is the explicit result output.

- slices come from canonical `execution/plans/slice-NN.md` and
  `execution/tasks/slice-NN.md` names;
- tasks are checklist rows in task artifacts and are reported per slice;
- operation counts, retries, rejections, findings cycles, dispatches, and child
  usage come from the journal;
- PLAN/TASKS bytes are sums of UTF-8 file bytes;
- words are zero for trimmed empty text, otherwise `trim().split(/\s+/u)`;
- changed-file count comes from Git status;
- `finalDiffBytes` is the Git binary diff byte length plus untracked file bytes;
- the requirements hash is SHA-256 of prepared `requirements.md`;
- the seed hash is calculated from the immutable source seed.

The benchmark does not reproduce the Sentinel state machine. For `case` and
`full`, the journal must end with a successful
`VALIDATE_SLICE(resultingState=COMPLETE) ->
SPEC_READINESS(resultingState=GLOBAL_READY) -> SPEC_CLOSE` sequence, with no
later execution operation, one terminal readiness, and one terminal close.
`finalize` then invokes the official execution validator read-only and accepts
terminal success only when it independently derives `COMPLETE`. Documentary
closure is likewise validated read-only by the official lifecycle validator.
Final tests and minimal terminal artifact structure must also pass; a focal run
may intentionally stop earlier.

`ABORTED_BUDGET` remains dominant. A recovered historical `BLOCKED` event stays
in journal metrics but does not condemn an otherwise healthy terminal run.
`BLOCKED` is reserved for an effective current blocker, including an official
execution inspection that rejects the terminal state or requires recovery;
other inconsistent terminal facts produce `FAIL`.

The journal SHA must match the actual `sentinel-workflows` checkout HEAD, both at
initialization and final collection. `finalize` also compares the prepared
`requirements.md` hash with the selected Case hash in the manifest. Both observed
facts and their match booleans are preserved in the result, and a mismatch makes
the run fail.

Final tests run as `node --test` in the prepared workspace. The result stores
only the command, exit code, and pass/fail outcome, never the full test log.

Token counts are never estimated. Run-level input/output totals are emitted only
when every journal event has actual input and output token telemetry; otherwise
telemetry is explicitly unavailable and totals are `null`.

## Comparison

`compare` requires matching benchmark id, version, Case, seed content hash,
requirements hash, and Production Profile id. Results from different benchmark
definitions are rejected rather than normalized. For compatible results it
prints raw before/after values and numeric `after - before` deltas, then shows
expected and actual model/effort use and outcome facts. Optional telemetry
appears only when available on both sides. It does not rank the runs or collapse
them into an aggregate value.
