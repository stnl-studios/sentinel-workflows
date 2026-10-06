# Sentinel Todo benchmark

## Running the benchmark

For a fresh diagnostic full run at the repository root, run:

```sh
npm run benchmark
```

No install is needed. The functional mode of the existing campaign driver checks
the benchmark and activity, preserves compact reports from eligible previous
runs, and cleans only recognized, owned, inactive scratch through the manager's
cleanup, including private homes. It then starts exactly one new full manager
run: A first, followed by B/C concurrently only after A passes. Unknown or
ambiguous data is preserved and reported; a previous run whose report cannot be
preserved keeps its raw files.

The command publishes terminal results, including BLOCKED, cancellation and
budget pauses, to [`measurements/latest.json`](measurements/latest.json) and
[`measurements/latest.md`](measurements/latest.md), with immutable per-run
history at `measurements/<run-id>.json`. Latest shows the last published round,
including a blocked round. The Markdown is a deterministic view of that JSON.
The current run's raw evidence and snapshot remain in ignored `benchmark-temp/`
for diagnosis until a later preparation can safely preserve and clean them.

A dirty checkout, unpublished HEAD, missing baseline or unavailable comparison
does not prevent functional use. Reports retain the real HEAD, dirty state and
frozen source identity. A failure before a terminal run exists does not invent a
measurement or replace latest. Missing evidence or a publication failure keeps
scratch and reports the limitation alongside the execution result.

For the formal measurement campaign, explicitly run:

```sh
npm run benchmark:campaign
```

That command retains the formal clean-checkout and active-process checks,
safe-scratch cleanup, baseline comparison, and report promotion to
`measurements/<campaign-id>/` for review and commit. The campaign summary
retains every value and leaves G2/G3 decisions pending.
That pending status describes the protocol's historical pre-acceptance
checkpoint. The final P0 acceptance subsequently recorded G2 and G3 as
PROVEN in [`maintenance/p0-summary.md`](../../maintenance/p0-summary.md).
This benchmark README documents measurement procedure; it is not the authority
for P0 acceptance status.

A blocked run or Ctrl+C stops the formal sequence and preserves scratch evidence;
no partial formal campaign is promoted. The functional command independently
publishes the available terminal result. Active or ambiguous scratch requires
inspection before cleanup. `npm run benchmark:verify` and `npm run benchmark:status` remain
available for standalone diagnostics. The Node commands below remain available
for advanced debugging.

This benchmark is measurement and regression tooling for the stabilized Sentinel
workflow on a small Todo CLI. It is not requirements, lifecycle, or execution
authority.
`seed/` contains the starting application. `cases/` contains three independent
requirements sources. `benchmark.json` fixes the case paths, production-v3
model profile, budgets, result schemas, and qualification evidence.
`qualification/` holds the byte-preserved sandbox probe referenced and hashed by
the manifest. Its P0 status and next step describe the probe date, not the
current checkpoint. The Sentinel skills and their official validators remain
workflow authority.

## Functional baseline

The initial comparison reference is the full run
`run-20260927034729-712b2b42` (2026-09-27 03:47–05:02 UTC), recorded under
ignored `benchmark-temp/`. A, B, and C each passed on one frozen functional
revision using `production-v2`; all reached execution `COMPLETE`, closed their
SPECs, and passed their finalizers. There was no terminal READINESS. The source
identity was
`sha256:f27aa88249b86e12ae8fb791e7bddc64027e9119b51178deb4dc3f5ec6650c8a`
and the frozen snapshot was
`sha256:756ea114ca305699a95cec0192d7c70c78c3c77dcba6a1a23e4c4b9a5134b93a`.
The published functional checkpoint is
`1a6195816b78f50c686b36143460b26f157baed6`; the later repository-hygiene
checkpoint is `3a40958dac6edc8ff28c76b72170611ee3983e05` and was not
proved by another live full run. The source identity belongs to the reference
run. The durable measurement is
[`baselines/baseline-v1.json`](baselines/baseline-v1.json); its original raw
artifacts are temporary diagnostic data.

## Run manager internals

Run from the repository root:

```sh
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --full
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --case A
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --case A --max-operations 4
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --resume <focal-run-id> --max-operations 3
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs status
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs status --run <run-id>
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs inspect --run <run-id> --case A
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs clean --run <run-id>
node benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs export --run <terminal-full-run-id> --output <absent-report-path>
node benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs compare --before <baseline-or-report.json> --after <report.json>
```

`run --full` requires A to pass before starting B and C concurrently. The
manager derives each next operation from official execution readback, takes
model and effort from the manifest's current `production-v3`, fills the versioned human launcher for
that operation, and sends those exact bytes through the pinned official Codex
SDK. Every invocation of a launcher template starts a new thread, including
authors, reviewers, repeated operations, and the next operation after a focal
resume. Persisted state and the selected template supply the handoff; prior
conversation history is never attached. Recorded thread IDs remain diagnostic
data, not inputs for resuming the next template. A focal run can be resumed
only if its frozen functional source, last official state, and fingerprint
still match. After execution reaches `COMPLETE`, the manager proceeds directly
to `SPEC_CLOSE`. It does not retry a blocked operation by guessing a handoff.

An exact provider capacity rejection can receive one retry after 15 seconds,
before terminalization, with the same model, effort and launcher. This requires
a complete SDK trace with no tools, or the successful owned managed preflight
and at most one literal `/bin/cat` read of the invoked frozen skill. That read
must match the installed snapshot file, output, identity and read-only modes;
the managed HOME must have no user zsh startup files. Workspace/candidate bytes
and modes, snapshot, skill copy and current authority must remain unchanged,
with an idle broker. A pinned SDK exit `1` after the complete capacity stream is
eligible only with empty stderr or the exact capacity diagnostic; other process
errors remain ineligible. Unqualified `cat`, other commands, pending effects,
uncertain transport, generic errors or insufficient budget block the retry.
Manager evidence preserves the provider event and process classification, hashes
the original process diagnostic instead of copying stderr, and records the
canonical reason for an ineligible retry. Each dispatched attempt retains
its diagnostic, thread and usage observation, consumes a turn and counts toward
operation budgets. Unknown usage remains unavailable. Terminal FULL runs are
never reopened by this policy.

While retained, each run is visible under `benchmark-temp/<run-id>/`: frozen source
snapshot and hashes, case workspaces, candidates, sent prompts, event JSONL,
operation evidence, journal, finalizer raw, and summaries. A blocked or
cancelled run is retained. `status` and `inspect` are read only and use no model.
`clean` requires one explicit owned, inactive, completed run ID. Promote an
important full run's canonical measurement before removing its raw directory.
Measurement export and publication accept only terminal `full` runs, including
failed full-suite attempts for diagnosis. `case` and `focal` remain scratch
evidence; the launcher's existing safe cleanup skips their measurement export.
The versioned `benchmark.json` sets `turnBudget.maxTurnsPerRun` to 100. Every
new run starts with zero consumed turns and keeps its reservation ledger inside
that run directory. B and C share that run budget safely while executing
concurrently. Resume uses the same ledger; the summary records consumed main
and runner turns. The historical top-level `.turn-ledger.json` is ignored.

The separate Codex home for each case uses a private ChatGPT login cache copy
and the frozen skill bundle. Benchmark agents now use Full Access:
`sandbox_mode = "danger-full-access"`, with SDK `sandboxMode: "danger-full-access"`
and `approvalPolicy: "never"` for both author and independent runner threads.
The case config contains no named filesystem profile or read/write-root rules.
Verification requires an effective unrestricted filesystem, enabled network,
no denied-read rules, and approval policy `Never`; a constrained report blocks
the run. This does not override host or organization requirements.

The snapshot, disposable workspace, and copied skills separate development
files from the global installation; they do not provide a host security sandbox.
Agents can technically reach the main Codex home, repository source, sibling
cases, credentials, and other host files, and can use the network. Workflow
instructions retain their authorized artifact scope and the runner's read-only
role. Hash/provenance checks, validators, publishers, and authorship rules verify
integrity; they do not prevent arbitrary host access. At a focal stop, the private home retains only session state
and its auth cache copy is deleted; resume restores the cache after validating
the frozen state. The private home is removed after a completed case. The
configured `stnl_validation_runner` is a separate Luna/medium SDK thread;
the product skill invokes its adapter through the case broker. The main
context, runner, official validators, and publishers keep their existing
ownership boundaries.

The local `main` reference at `73e37420aa093463a2dfb14964bf959c54f194b2`
used the restricted `sentinel-case` profile, SDK 0.154.0, and approval policy
`never`, without an explicit SDK sandbox mode. Retained full PASS measurements
from 2026-09-30 also record restricted execution. Their raw snapshots are no
longer available; they do not prove historical Full Access. Current Full Access
results therefore have a different permission context from those measurements.

Development runs test the frozen SOURCE and its isolated skill copies without
installing them globally. Preserve that separation from the installed version
used by projects. Only the runner's one bounded format-only repair may continue
its current thread within the same invocation; a later template or independent
runner invocation starts fresh. Both repair turns retain their events and usage
and consume the existing turn budget.

## Production profile

The current manifest defines `production-v3`; the historical baseline above
retains its original `production-v2` identity. Requested dispatch is not proof
of the provider's reported model.

| Phase | A | B | C |
| --- | --- | --- | --- |
| SPEC | GPT-6.1-Sol / medium | GPT-6.1-Sol / high | GPT-6-Astra / high |
| PLAN | GPT-6-Luna / high | GPT-6.1-Sol / medium | GPT-6.1-Sol / high |
| TASKS | GPT-6-Luna / high | GPT-6.1-Sol / medium | GPT-6.1-Sol / high |
| EXECUTE / APPLY_FINDINGS | GPT-6-Luna / high | GPT-6-Luna / high | GPT-6.1-Sol / high |
| REVIEW / VALIDATE | GPT-6-Luna / high | GPT-6.1-Sol / medium | GPT-6-Astra / high |

`SPEC_INIT` and `SPEC_CLOSE` use SPEC. `SPEC_READINESS` uses REVIEW / VALIDATE.
Requested dispatches, provider usage when available, independent runner
turns, and official outcomes are recorded separately. Missing usage is
unavailable, never estimated.

## Fixture and collector

`runtime/benchmark.mjs` still owns deterministic fixture preparation,
journaling, `verify`, `doctor`, finalization, and comparison. These commands
make no model call:

```sh
node benchmarks/sentinel-todo/runtime/benchmark.mjs verify
node benchmarks/sentinel-todo/runtime/benchmark.mjs doctor
node benchmarks/sentinel-todo/runtime/benchmark.mjs prepare --case A --output <absolute-absent-path>
node benchmarks/sentinel-todo/runtime/benchmark.mjs finalize --workspace <absolute-workspace> --case A --spec <absolute-spec-path> --journal <absolute-journal.json> --output <absolute-result.json>
node benchmarks/sentinel-todo/runtime/benchmark.mjs compare --before <absolute-result.json> --after <absolute-result.json>
```

Preparation copies seed files byte for byte, selects only that case's
requirements as `requirements.md`, runs seed tests, and creates a local Git
baseline. It does not place benchmark profile, rubric, prior results, or
expected answers inside the case workspace. The fixed SPEC roots are
`specs/benchmark-case-a`, `specs/benchmark-case-b`, and
`specs/benchmark-case-c`; lifecycle INIT creates them.

The journal records attempted operations, actual model and effort, outcome,
duration, and telemetry when supplied. `finalize` reads official lifecycle and
execution state, verifies the terminal sequence and workspace, runs final
tests, and writes a canonical raw result even when terminal status is blocked
and the command exits nonzero. Managed runs retain their detailed results in
ignored `benchmark-temp/`. A full PASS requires a single coherent A/B/C run of
one frozen functional revision.

## Benchmark Protocol v1

The baseline is the first tracked, machine-readable reference measurement of
one completed full A/B/C run. A measurement is the canonical report exported
from a terminal run, with run and snapshot identity, official case results,
operation counts, token telemetry, and coverage. It is a record of observations,
not a new workflow authority. The source and frozen snapshot must pass integrity
checks at export. The source checkout may have advanced since the run.

`benchmark-temp/` is scratch space: runs, snapshots, candidate workspaces,
prompts, event streams, focals, private runtime metadata, active-run markers,
and turn ledgers all belong there. `benchmark.json`, this protocol, and promoted
measurements belong in Git. Export a canonical report for any run used as a
baseline, comparison reference, or gate evidence, then review and commit that
small report. The default command publishes these compact reports automatically;
the formal campaign retains its explicit promotion. Do not copy raw trees into
Git. Preparation preserves reports before cleaning eligible scratch and retains
unrecognized data. A fresh run recreates its runtime state from the versioned
manifest; no old ledger, focal artifact, or handshake is required.

`measurements/` is output, excluded from functional source selection, copying
and diffs. Its changes still appear in the real working-tree dirty state.
Historical snapshots are verified using their original recorded evidence.

### G2: operational repetition

Count official journal operations, main turns, and runner turns per case and
slice. Show repeated `EXECUTE_SLICE` and `VALIDATE_SLICE` attempts per slice as
`max(0, attempts - 1)`; show review rounds beyond the first, runner check
rounds, and `APPLY_FINDINGS`, `REPLAN`, and `SPEC_RESUME` separately. Report
operations per slice and total turns per case. Recovery operations and findings
remain visible beside happy-path operations. An extra recovery caused by a real
finding is evidence of extra work, but does not alone establish unnecessary
workflow repetition. No opaque repetition score is used.

### G3: observed token and context pressure

Use attributable provider usage deltas for main and runner turns. Report input
and output token totals separately by role, input per observed turn, peak and
median turn input, and the observed/expected telemetry coverage. Where actual
telemetry exposes them, cached input and reasoning output are subcategories of
those totals and are never added again. Missing or partial telemetry is
`unavailable` with coverage; it is not zero and is not inferred from text size.
Input per turn is a context-pressure proxy, not a measurement of context-window
occupancy or billing.

Each fresh thread's usage is attributed from its own zero baseline; a bounded
same-thread format repair contributes only the additional cumulative usage.
Repeated observations are not counted twice, and missing usage stays
unavailable. Changing template thread reuse to fresh chats is an experimental
context change: record the frozen source identity and do not infer token/cost
savings or direct parity with historical reused-thread runs from offline tests.

### Direct comparison and campaign

Compare reports directly only when the measurement schema and metric
definitions, benchmark version, case requirements hashes, seed hash, result
schema, qualification contract, and production profile match. A deliberately
changed profile is an explicit experimental variable and must be labelled as
such. A difference in metric definitions or fixture/qualification contract
blocks automatic better/worse conclusions. Both runs must have the required
full PASS conclusion before performance deltas are meaningful; token deltas
also require sufficient observed coverage. A partial run with fewer operations
or tokens is not an improvement. A missing or incompatible baseline never
blocks publication and does not replace `baselines/baseline-v1.json`.
Durations, slice counts, final
tests, provider, auth mode, isolation, profile mismatches, and finalizer status
are diagnostic dimensions where recorded; they are not G2 or G3 scores.

For the initial functional comparison, use one full run per
configuration. Preserve the report, and summarize median,
minimum/maximum, and success rate without hiding outliers. Stop interpreting
G2/G3 when integrity fails, runs are incomplete, or the comparison contract
does not match. One sample checks function but does not establish a mature
statistical distribution. The versioned
`campaign.fullRuns` setting can be raised explicitly in the future. No
retrospective threshold is set from the reference run. Under the protocol's
historical pre-acceptance state, G2 and G3 stayed `PARTIAL` pending comparable
empirical evidence and an explicit gate decision. The later acceptance decision
is recorded in [`maintenance/p0-summary.md`](../../maintenance/p0-summary.md);
this protocol text does not describe the current P0 status. This change does not
start the campaign.
