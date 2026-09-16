# Sentinel Benchmark v1

`sentinel-todo` is a small, permanent, dependency-free benchmark fixture for
measuring raw Sentinel workflow behavior. It is engineering infrastructure, not
requirements authority, runtime authority, execution authority, or an implicit
context source for any skill.

The benchmark runtime never calls a provider, starts an agent, selects a model,
or orchestrates the workflow. A later Codex-run protocol drives Sentinel and
records each observed operation immediately in the external journal.

## Layout and isolation

- `seed/` is the original Todo CLI copied for every Case.
- `cases/` contains requirements sources, not prewritten SPECs.
- `benchmark.json` owns the reproducible Production Profile, fixed SPEC paths,
  budgets, run modes, and schema versions.
- `runtime/benchmark.mjs` prepares workspaces, records a journal, enforces
  budgets, collects raw facts, and compares results.
- `schemas/` documents the journal and result JSON contracts.

Every prepared workspace contains only the seed files plus the selected Case as
`requirements.md`. It never receives the manifest, schemas, budgets, profile,
prior results, evidence, rubric, or expected answers. Cases are independent:

```text
seed -> A
seed -> B
seed -> C
```

The fixed paths are `specs/benchmark-case-a`,
`specs/benchmark-case-b`, and `specs/benchmark-case-c`. The selected SPEC path
must not exist after `prepare`.

## Production Profile v1

| Phase | Case A | Case B | Case C |
| --- | --- | --- | --- |
| SPEC | Terra / high | Terra / high | Sol / high |
| PLAN | Terra / high | Terra / high | Sol / high |
| TASKS | Terra / high | Terra / high | Terra / high |
| EXECUTE / APPLY_FINDINGS | Luna / high | Luna / xhigh | Luna / xhigh |
| REVIEW / VALIDATE | Luna / high | Luna / xhigh | Luna / xhigh |

The journal stores actual dispatches. A difference from this expected profile is
preserved as a mismatch; the runtime never silently substitutes a model or
effort.

## Commands

All paths supplied for workspaces, journals, and results are absolute. Paths with
spaces and Unicode are supported.

```text
node benchmarks/sentinel-todo/runtime/benchmark.mjs verify
node benchmarks/sentinel-todo/runtime/benchmark.mjs prepare --case A --output <absolute-absent-path>
node benchmarks/sentinel-todo/runtime/benchmark.mjs journal-init --output <absolute-journal.json> --case A --sentinel-sha <sha> --run-mode case --production-profile production-v1
node benchmarks/sentinel-todo/runtime/benchmark.mjs journal-event --journal <absolute-journal.json> --operation PLAN --phase PLAN --model GPT-5.6-Terra --effort high --result PASS
node benchmarks/sentinel-todo/runtime/benchmark.mjs finalize --workspace <absolute-workspace> --case A --spec <absolute-spec-path> --journal <absolute-journal.json> --output <absolute-result.json>
node benchmarks/sentinel-todo/runtime/benchmark.mjs compare --before <absolute-result.json> --after <absolute-result.json>
```

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
  -> lifecycle MODE=CLOSE
  -> result
```

There is no execution `CLOSE`. Journal operation `SPEC_CLOSE` means lifecycle
`MODE=CLOSE`. Zero findings is a valid run.

Run modes are `focal` for an explicitly selected subset, `case` for one complete
Case, and `full` for three externally coordinated Case runs. The runtime does not
create a multiprocess or model orchestrator.

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

The benchmark does not reproduce the Sentinel state machine. It requires an
observed final execution readback from `VALIDATE_SLICE` with
`resultingState=COMPLETE` immediately before terminal `SPEC_CLOSE`, and checks
only minimal terminal execution-artifact structure. Documentary closure is
validated read-only by the official lifecycle validator rather than inferred by
the benchmark. For `case` and `full`, final COMPLETE, official closure, and final
tests are required; a focal run may intentionally stop earlier.

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

`compare` requires matching benchmark id, version, and Case. It prints raw
before/after values and numeric `after - before` deltas, then shows expected and
actual model/effort use and outcome facts. Optional telemetry appears only when
available on both sides. It does not rank the runs or collapse them into an
aggregate value.
