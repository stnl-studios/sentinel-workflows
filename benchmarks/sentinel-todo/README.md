# Sentinel Todo benchmark

This benchmark measures the published Sentinel workflow on a small Todo CLI.
`seed/` contains the starting application. `cases/` contains three independent
requirements sources. `benchmark.json` fixes the case paths, production-v2
model profile, budgets, and result schemas. The benchmark is infrastructure;
the Sentinel skills and their official validators remain workflow authority.

## Run manager

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
```

`run --full` requires A to pass before starting B and C concurrently. The
manager derives each next operation from official execution readback, takes
model and effort from `production-v2`, fills the versioned human launcher for
that operation, and sends those exact bytes through the pinned official Codex
SDK. Reviewer operations use independent threads. A focal run can be resumed
only if its frozen functional source, last official state, and fingerprint
still match. After execution reaches `COMPLETE`, the manager performs terminal
global `SPEC_READINESS` before `SPEC_CLOSE`. It does not retry a blocked
operation by guessing a handoff.

Each run stays visible under `benchmark-temp/<run-id>/`: frozen source
snapshot and hashes, case workspaces, candidates, sent prompts, event JSONL,
operation evidence, journal, finalizer raw, and summaries. A blocked or
cancelled run is retained. `status` and `inspect` are read only and use no model.
`clean` requires one explicit owned, inactive, completed run ID. Leave the
latest run in place for inspection.

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
and the command exits nonzero. Historical raw results remain intact. A full
PASS requires a single coherent A/B/C run of one frozen functional revision.
