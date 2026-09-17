# S3 Benchmark Environment Qualification v1

## Base

- branch: `feature/atlas-p0`
- HEAD: `2f4bf84e45d94e6b2bdb503edcbb2f8927e133de`
- parent: `81e0258295c8e6b57e85d81f083c47f76469fda8`
- commit: `docs(benchmark): record blocked Production Pilot #3`
- initial working tree: clean, with no relevant untracked files
- parent-to-HEAD scope: Pilot #3 raw result and evidence only

## Purpose

This checkpoint is Benchmark Environment Qualification v1. It qualifies the
host filesystem, process environment, managed temp policy, Node, local Git,
path portability, sandbox process, and cleanup. It does not evaluate Sentinel
quality, alter any P0 gate, or constitute a Production Pilot or Correction #3.

## Doctor

Both qualification runs emitted one sanitized JSON line, exited `0`, and
reported `ENVIRONMENT_READY` with no blocker code.

| Check | Run 1 | Run 2 |
| --- | --- | --- |
| Node runtime, child start, `node --test`, exit preservation | PASS | PASS |
| disposable local Git | PASS | PASS |
| global Git configuration preserved | PASS | PASS |
| OS temp safety and writability | PASS | PASS |
| managed session temp | PASS | PASS |
| managed TMPDIR operations | PASS | PASS |
| child environment inheritance | PASS | PASS |
| path with spaces | PASS | PASS |
| Unicode path | PASS | PASS |
| macOS canonicalization | PASS | PASS |
| filesystem operations | PASS | PASS |
| symlink cleanup safety | PASS | PASS |
| Sentinel checkout preservation | PASS | PASS |
| benchmark seed preservation | PASS | PASS |
| cleanup | PASS | PASS |

The stable fingerprint fields and all check statuses were identical across the
two runs. The independent environment suite also ran the doctor twice and
compared the same stable fields structurally.

## Managed temp policy

Each benchmark session owns one unique OS-temp-derived session root outside the
Sentinel checkout. The root is canonicalized with `realpath` and contains only
session-owned `workspaces`, `journals`, `results`, and `runner-tmp` children.
Processes that may create temp receive `runner-tmp` through their process
environment. Cleanup removes only the canonical owned session root and fails
closed. No absolute session path is persisted.

## Luna sandbox probe

Exactly one real agent probe ran. GPT-5.6-Luna / medium started with the managed
TMPDIR already present in its process environment and with the
`workspace-write` isolation class. The command inside the agent did not define
or replace TMPDIR. It invoked the environment-only doctor probe against a
neutral seed-only local Git workspace.

| Probe | Result |
| --- | --- |
| Model | GPT-5.6-Luna |
| Effort | medium |
| Workspace | PASS |
| TMPDIR inherited | PASS |
| `os.tmpdir()` canonical match | PASS |
| `mkdtemp` | PASS |
| write/read | PASS |
| rename/remove | PASS |
| `node --test` | PASS |
| Git tree preserved | PASS |
| unexpected effects | none |

The workspace was clean before and after the probe, no tracked bytes changed,
and the complete one-off session root was removed without residue. The probe
was not retried and is not G4 evidence.

## Global preservation

- Sentinel checkout status: preserved relative to the pre-doctor/probe state.
- benchmark seed source: byte-identical.
- relevant global Git configuration fingerprints: unchanged.
- global Git configuration content and values were not persisted.
- no shell profile, user environment, or global Git setting was changed.
- Production Pilot #1/#2/#3 raw results: byte-identical.

## Environment fingerprint

| Field | Value |
| --- | --- |
| environment contract version | 1 |
| platform | darwin |
| architecture | arm64 |
| Node | v22.20.0 |
| Git | 2.51.0 |
| benchmark version | 1 |
| runner probe model | GPT-5.6-Luna |
| runner probe effort | medium |
| doctor | PASS |
| sandbox probe | PASS |

No hostname, username, home directory, repository path, temp path, process
environment, credential, or Git configuration value is persisted.

## Historical integrity

| Raw result | Before SHA-256 | After SHA-256 | Identity |
| --- | --- | --- | --- |
| Pilot #1 | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | `6a868b218ac1f09f393e2ad3c65fcd7d8105297f122a4ae0a803f64bb0864485` | byte-identical |
| Pilot #2 | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | `950adf212cf7e13e317d3653e92afc1b77b8d56afbf7f50173263a25c0042882` | byte-identical |
| Pilot #3 | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | `3b9966b9e6a21f0a43c597394eb4d9d104aa3e8890561f2489c64f162debd6a8` | byte-identical |

No historical status was recalculated.

## Tests

The same baseline set passed before editing. Integrated validation after the
implementation produced:

| Command | Exit | Result |
| --- | ---: | --- |
| `git diff --check` | 0 | PASS |
| `node benchmarks/sentinel-todo/runtime/benchmark.mjs verify` | 0 | PASS |
| seed `node --test` | 0 | 8/8 PASS |
| `node scripts/test-benchmark-contract.mjs` | 0 | 8/8 PASS |
| `node scripts/test-benchmark-environment.mjs` | 0 | 4/4 PASS |
| `node --test scripts/test-execution-contract.mjs` | 0 | 93/93 PASS |
| `node scripts/check-contracts.mjs repository --root .` | 0 | PASS |
| `bash scripts/validate.sh --no-smoke` | 0 | PASS |

## Reviewer

The single independent GPT-5.6-Sol / high read-only reviewer returned:

`PASS`

## Invalidates when

Requalification is required after a host execution environment, OS,
architecture, relevant Node, or relevant Git change; a benchmark doctor or
environment contract change; an agent sandbox mechanism change; a validation
runner adapter/environment mechanism change; a TMPDIR policy change; or any
environment-related blocker in a Pilot.

Every future Production Pilot reruns the deterministic doctor. A new
qualification/session, changed fingerprint or sandbox mechanism, or prior
environment blocker also requires the one-shot Luna environment probe before
Case A.

## Scope preservation

- `skills/**`, `agents/**`, and `templates/**`: unchanged.
- Sentinel execution and lifecycle runtimes: unchanged.
- benchmark Cases, requirements, Production Profile, budgets, and seed
  behavior: unchanged.
- result and journal schemas and `benchmarkVersion`: unchanged.
- no Production Pilot was executed.

## Status

`BENCHMARK_ENVIRONMENT_READY`

## P0 ledger

- G1 = PROVEN
- G2 = PARTIAL
- G3 = PARTIAL
- G4 = PROVEN
- G5 = PROVEN
- G6 = NOT_YET_PROVEN

Environment qualification does not promote or reopen any gate.

## Resulting commit

`pending user commit`
