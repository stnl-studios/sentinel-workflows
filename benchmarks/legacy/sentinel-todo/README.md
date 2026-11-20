# Sentinel Todo benchmark

This benchmark evaluates the Sentinel workflow against three independent Todo CLI requirements. It is a maintainer tool in this repository; it is not installed with customer skills and agents, and it does not change the workflow's authority.

## Requirements

- Node.js 18 or newer.
- An authenticated Codex CLI for runs that invoke a model.
- The pinned Codex adapter dependencies installed from the lockfile:

```sh
npm ci --prefix agents/codex
```

The benchmark uses the Codex SDK and App Server transport included in the repository's maintainer tooling. The customer installer does not install either package. Running a campaign can make model calls and create local evidence; use it only when a campaign is intended.

## Commands

From the repository root:

```sh
npm run benchmark                 # Functional campaign
npm run benchmark:campaign        # Full measurement campaign
npm run benchmark:verify          # Verify manifest, seed and cases offline
npm run benchmark:status          # Inspect local campaign state
```

Both campaign commands use the run count in `benchmark.json` (currently three) and accept `--runs N`. A functional campaign accepts at most three full runs. Runs are sequential; each evaluates case A before cases B and C. The first failure, cancellation, uncertain outcome or publication error stops admission of later runs. The full campaign can also stop after a bounded number of operations and resume only from its own valid checkpoint.

The run manager also supports focal and single-case runs, read-only inspection, explicit cleanup of an owned completed run, and report export/comparison:

```sh
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --case A --max-operations 4
node benchmarks/sentinel-todo/runtime/benchmark-campaign.mjs --resume <campaign-id> --runs <original-run-count>
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs status --run <run-id>
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs inspect --run <run-id> --case A
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs clean --run <run-id>
node benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs export --run <run-id> --output <absent-report-path>
node benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs compare --before <report.json> --after <report.json>
```

Consult [`INTERFACES.md`](INTERFACES.md) for evidence ownership, result boundaries and retention behavior.

## Results and interpretation

Functional success, formal workflow completion, product-oracle results and measurement completeness are separate outcomes. A functional campaign requires the configured number of coherent A/B/C passes on one frozen source. Missing usage or coverage remains explicitly incomplete; missing values are never zero. An incomplete result cannot be presented as a qualified measurement or as evidence of savings.

Comparisons require compatible source, schema, profile and qualification metadata. An unavailable or incompatible baseline leaves deltas unavailable; it does not turn an otherwise valid current run into a failure. Do not infer billing, model-token totals, runtime behavior or customer-client compatibility beyond what the preserved evidence observes.

The most recent retained canonical report is [`measurements/latest.md`](measurements/latest.md), with its JSON source alongside it. [`baselines/baseline-v1.json`](baselines/baseline-v1.json) is a historical comparison input; its original identity and limits remain part of the data. Dated run reports and notes are retained as evidence and should not be rewritten to match current code.

## Repository layout

- `seed/` — starting Todo CLI and its tests.
- `cases/` — the independent requirements for cases A, B and C.
- `benchmark.json` — case paths, model profile, run budget and schema identities.
- `runtime/` — preparation, provider, campaign, verification and measurement tools.
- `schemas/` — versioned journal and result formats.
- `baselines/`, `measurements/` — preserved reference and measured results.
- `qualification/` — source evidence used by the benchmark manifest.

Run workspaces, prompts, journals and raw diagnostics are kept in the ignored `benchmark-temp/` directory. Starting another campaign does not purge prior runs. The customer installer excludes benchmark code, benchmark dependencies and campaign data.
