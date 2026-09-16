# S3 Benchmark v1 Infrastructure

## Purpose

Provide a small, permanent, replicable, and inexpensive fixture plus protocol,
external journal, raw-metric collector, and before/after comparator for future
Sentinel P0 measurements.

## Base

- Branch: `feature/atlas-p0`
- Base SHA: `20dba78f7fc4a362c80c14b4e4d33d0dd64e3a28`
- Base commit: `docs(maintenance): record Terra requalification evidence`
- Parent: `51af7df0d8e1abad319b514cfb548c121e571211`

## Structure

- `benchmarks/sentinel-todo/benchmark.json`: benchmark identity, fixed SPEC paths,
  Production Profile v1, run modes, schema versions, and bounded budgets.
- `benchmarks/sentinel-todo/seed/`: dependency-free Node.js ESM Todo CLI.
- `benchmarks/sentinel-todo/cases/`: independent small, medium, and transversal
  requirements sources.
- `benchmarks/sentinel-todo/runtime/benchmark.mjs`: offline prepare, journal,
  budget, finalize, and compare commands.
- `benchmarks/sentinel-todo/schemas/`: journal and result contracts.
- `scripts/test-benchmark-contract.mjs`: cheap deterministic contract evidence.

## Production Profile

- Case A: Terra for SPEC/PLAN/TASKS; Luna for EXECUTE/REVIEW/VALIDATE; high effort.
- Case B: Terra for SPEC/PLAN/TASKS at high; Luna for EXECUTE/REVIEW/VALIDATE at xhigh.
- Case C: Sol for SPEC/PLAN at high; Terra for TASKS at high; Luna for
  EXECUTE/REVIEW/VALIDATE at xhigh.

## Cases

- A: filter Todo listing by completed or pending state.
- B: add persisted priority with backward compatibility.
- C: archive and unarchive while preserving legacy data compatibility.

Every Case starts from the original seed.

## Raw metrics

The collector records decomposition, workflow operation counts, review rounds,
replans, findings cycles, retries, mechanical rejections, actual model/effort
dispatches, child dispatches, explicit escalations, PLAN/TASKS sizes, optional
handoff/read data, actual token telemetry only when complete, Git change facts,
fixture hashes, final execution state, lifecycle closure, and final tests.

No aggregate score is produced.

## Budgets

All Cases allow at most two PLAN reviews, two TASKS reviews, one REPLAN, three
EXECUTE attempts per slice, and two APPLY_FINDINGS calls per slice. Total event
limits are 14 for A, 20 for B, and 24 for C. Exceeding a limit terminalizes the
journal as `ABORTED_BUDGET` without automatic retry.

## Status

`BENCHMARK_READY_FOR_PILOT`

The benchmark E2E has not been executed. No gate G2, G3, G4, or G6 is promoted
by this infrastructure patch. G5 remains `PROVEN`.

The P0 ledger remains:

- G1 = `PROVEN`
- G2 = `PARTIAL`
- G3 = `PARTIAL`
- G4 = `NOT_YET_RUNTIME_PROVEN`
- G5 = `PROVEN`
- G6 = `NOT_YET_PROVEN`

Resulting commit: `pending user commit`
