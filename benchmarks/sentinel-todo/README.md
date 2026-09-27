# Sentinel Todo benchmark

## Formal campaign

From a clean, published checkout at the repository root, run:

```sh
npm run benchmark
```

No install is needed. The command checks the checkout and active processes,
cleans safe prior scratch, runs `verify`, and executes three independent full
runs in sequence. It exports and compares each measurement against
`baselines/baseline-v1.json` inside ignored `benchmark-temp/`. Only after all
three runs pass with one functional source identity and direct comparability
does it promote `run-01.json`, `run-02.json`, `run-03.json`, and
`campaign-summary.json` to `measurements/<campaign-id>/` for review and commit.
The campaign summary retains every value and leaves G2/G3 decisions pending.

A blocked run or Ctrl+C stops the sequence and preserves scratch evidence;
no partial campaign is promoted. A later campaign may clean terminal, owned
scratch automatically. Active or ambiguous scratch requires inspection before
cleanup. `npm run benchmark:verify` and `npm run benchmark:status` are optional
diagnostics. The Node commands below remain available for advanced debugging.

This benchmark is measurement and regression tooling for the stabilized Sentinel
workflow on a small Todo CLI. It is not requirements, lifecycle, or execution
authority.
`seed/` contains the starting application. `cases/` contains three independent
requirements sources. `benchmark.json` fixes the case paths, production-v2
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
node benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs export --run <completed-full-run-id> --output <absent-report-path>
node benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs compare --before <baseline-or-report.json> --after <report.json>
```

`run --full` requires A to pass before starting B and C concurrently. The
manager derives each next operation from official execution readback, takes
model and effort from `production-v2`, fills the versioned human launcher for
that operation, and sends those exact bytes through the pinned official Codex
SDK. Reviewer operations use independent threads. A focal run can be resumed
only if its frozen functional source, last official state, and fingerprint
still match. After execution reaches `COMPLETE`, the manager proceeds directly
to `SPEC_CLOSE`. It does not retry a blocked operation by guessing a handoff.

While retained, each run is visible under `benchmark-temp/<run-id>/`: frozen source
snapshot and hashes, case workspaces, candidates, sent prompts, event JSONL,
operation evidence, journal, finalizer raw, and summaries. A blocked or
cancelled run is retained. `status` and `inspect` are read only and use no model.
`clean` requires one explicit owned, inactive, completed run ID. Promote an
important run's canonical measurement before removing its raw directory.
The versioned `benchmark.json` sets `turnBudget.maxTurnsPerRun` to 100. Every
new run starts with zero consumed turns and keeps its reservation ledger inside
that run directory. B and C share that run budget safely while executing
concurrently. Resume uses the same ledger; the summary records consumed main
and runner turns. The historical top-level `.turn-ledger.json` is ignored.

The isolated Codex home for each case uses a private ChatGPT login cache copy,
the frozen skill bundle, and a restricted filesystem profile. The main Codex
home, repository source, sibling cases, and credentials are outside the agent
write/read scope. At a focal stop, the private home retains only session state
and its auth cache copy is deleted; resume restores the cache after validating
the frozen state. The private home is removed after a completed case. The
configured `stnl_validation_runner` is a separate Luna/medium SDK thread;
the product skill invokes its adapter through the case broker. The main
context, runner, official validators, and publishers keep their existing
ownership boundaries.

## Production profile

| Phase | A | B | C |
| --- | --- | --- | --- |
| SPEC | Sol / high | Terra / high | Sol / high |
| PLAN | Terra / high | Terra / high | Sol / high |
| TASKS | Terra / high | Terra / high | Terra / high |
| EXECUTE / APPLY_FINDINGS | Luna / high | Luna / xhigh | Luna / xhigh |
| REVIEW / VALIDATE | Luna / high | Luna / xhigh | Luna / xhigh |

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
small report. Routine diagnostic runs need no promotion. Do not copy raw trees
into Git. Once a campaign or step is finished and its important reports are
promoted, the entire `benchmark-temp/` directory may be deleted between
campaigns. A fresh run recreates its runtime state from the versioned manifest;
no old ledger, focal artifact, or handshake is required.

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

### Direct comparison and campaign

Compare reports directly only when the measurement schema and metric
definitions, benchmark version, case requirements hashes, seed hash, result
schema, qualification contract, and production profile match. A deliberately
changed profile is an explicit experimental variable and must be labelled as
such. A difference in metric definitions or fixture/qualification contract
blocks automatic better/worse conclusions. Durations, slice counts, final
tests, provider, auth mode, isolation, profile mismatches, and finalizer status
are diagnostic dimensions where recorded; they are not G2 or G3 scores.

For the first formal comparison, use three independent full runs per
configuration. Preserve every individual report, and summarize median,
minimum/maximum, and success rate without hiding outliers. Stop interpreting
G2/G3 when integrity fails, runs are incomplete, or the comparison contract
does not match. One isolated PASS is not statistical proof. No retrospective
threshold is set from the reference run: G2 and G3 stay `PARTIAL` until the
formal campaign supplies comparable empirical evidence and an explicit gate
decision. The campaign is not started by this protocol change.
