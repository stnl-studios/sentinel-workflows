# Sentinel Todo benchmark

## Adaptation status

U3.16 is implemented and accepted within its documented offline scope.
**Do not run the real manager/campaign yet:** S2/App Server capture, bundle
selection and child completion have been exercised with an offline provider,
not demonstrated in the normal authenticated client. S1 remains a historical
`NATIVE_TRANSPORT_UNPROVEN` diagnosis. Normal manager paths through Initial and
converted CLOSE/readers/export are covered mechanically; source retention fixes
were explicitly authorized in the product, without benchmark hooks. U3.15-D's
native acceptance belongs to its historical freeze and does not qualify the
changed candidate. See [interfaces](INTERFACES.md) and
[the current offline acceptance](../../maintenance/P1-B-PLANO.md#u316-retencao)
for tests, known historical failures and the approval gate before U3.17.
No real product/model/runner call was used in this adaptation's offline tests.

## Campaign entrypoints after qualification

```sh
npm run benchmark
npm run benchmark:campaign
```

Both entrypoints use `campaign.fullRuns` (default **3**) and accept an explicit
positive integer override, for example `npm run benchmark -- --runs 1` or
`npm run benchmark:campaign -- --runs 2`. Invalid, duplicated and unknown
arguments are rejected before preparation or dispatch. Each FULL retains the
manager's A-first, then B/C policy. A terminal B/C failure blocks admission of
later sibling operations. An already admitted operation settles under its original
deadline; this cooperative stop does not cancel its observation or invent a result.
FULLs are sequential; the first failure, cancellation, unavailable evidence or
publication error stops the sequence.

The formal campaign also accepts `--max-operations N` as an operational stop
after at most N additional operations per case. It retains FULL scope and never
qualifies a partial result. Resume with `npm run benchmark:campaign -- --resume
<campaign-id>` (repeat `--runs N` if the initial N overrode the manifest).
Only a settled checkpoint from the same candidate, controller and configuration
is eligible; accepted FULLs/cases are revalidated without executing them again.
Refusals, uncertain effects, altered evidence and historical runs without this
checkpoint are excluded. Costs and correction limits remain cumulative.
The offline tests use controlled hooks, not real FULLs.

Both entrypoints retain per-run reports and campaign state in ignored
`benchmark-temp/campaign-<id>/` (functional campaigns use `campaign-functional-<id>`).
Failed, interrupted or incomplete campaigns preserve their raw diagnostics and
cost ledgers there; they do not publish individual reports into official history.
Only after **N/N** coherent qualifying PASS FULLs does the existing atomic
promotion create `measurements/<campaign-id>/` with all compact reports and its
campaign summary. Existing history, including legacy `latest.json`/`latest.md`,
is preserved; the returned measurement path identifies the new campaign.
A failure before a run exists does not invent a measurement.

The formal entrypoint additionally requires a clean local Git candidate.
HEAD need not already be pushed; a cached
upstream is informational and does not prove remote synchronization. A baseline
is optional: absent, malformed or incompatible historical data leaves comparison
and deltas `unavailable`, separately from current N/N quality. Unexpected errors
in a compatible comparison stop the campaign. G2/G3 decisions remain explicit.
Historical P0 acceptance is recorded in
[maintenance/p0-summary.md](../../maintenance/p0-summary.md), not recertified here.

Neither entrypoint deletes/re-publishes another invocation's history when
starting. Active, foreign, unsafe or ambiguous scratch blocks dispatch. Retained
raw data, ledgers, interrupted states and owners are not discarded for a clean
start. Explicit manager cleanup still needs its own legal preconditions and
retain-before-clean qualification; it is not certified by these campaign tests.
`benchmark:verify` and `benchmark:status` remain diagnostic entrypoints.

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

### Required measurement evidence for U3.18

Functional execution, formal judgment, product oracle and measurement completeness
are separate results. Aj's complete benchmark acceptance requires consumption;
an ABC functional success with unavailable usage is not a qualified FULL. Keep
historical outputs unchanged and label them as functional evidence with missing
metrics. A diagnostic export retains the functional result and reports
`measurement.status: incomplete` with missing dimensions. It cannot be published
or used to certify savings. Missing values never become zero.

| Evidence | Existing authoritative source / unit | Aggregation and completeness |
| --- | --- | --- |
| Run, case, repetition, operation and attempt | campaign state, run.json, operation evidence, ledger; IDs/counts | Required. Match the frozen run and ABC/N scope; no missing, foreign or duplicate identities. |
| Wall time per operation/case/run | journal durationMs and startedAt/endedAt; milliseconds | Required. Preserve real boundaries. B/C overlap: summed case time is not run wall time. |
| Failed/cancelled attempts and pauses | ledger timestamps/states, operation records, recovery provenance | Required attempts and recorded boundaries. Wall time includes waiting. An exact model/observation-wait/administrative split is unavailable when the provider or preserved records do not distinguish it; do not manufacture that split. Unknown original exits/times stay unknown. |
| Input/cached input/output | public `thread/tokenUsage/updated`, scoped by threadId/turnId; tokens | Required for every admitted main/child turn, including failed attempts. Preserve official counter fields before normalization; establish cumulative/delta/final semantics and parent/child scope before summing. Cached input is a subset, not additional input. |
| Total tokens | attributable input + output; tokens | Derived only from complete compatible buckets. Never add cached or reasoning tokens again. Known partial subtotals must be labelled partial. |
| Reasoning/cache-write detail | provider's explicit counters; tokens | Retain when supplied. Never silently coerce an unsupported/missing field to zero; absence must remain explicit. |
| Calls, turns and admissions | scoped public turn IDs and ledger states/reservations; counts | Required. A skill operation may cause several model turns. Count all children/corrections; replay is not another dispatch. Reservations are not token usage or money. |
| Models and effort | frozen manifest, operation requests, official thread/binding metadata | Required declared profiles and available acknowledgements. Distinguish requested, acknowledged and unavailable provider-reported values; do not relabel a requested alias as an observed model version. |
| SDK/CLI, source, seed, schema and configuration | snapshot.json, manifest, freeze and effective public settings | Required reproducibility evidence. Preserve exact observed versions, hashes, overrides and context regime. A different global config hash needs an effective-settings check, not restoration by inference. |
| Formal result and product result | native receipts/terminal proof and independent productAcceptance | Required, separate from metrics. Formal PASS does not override an oracle failure or missing consumption. |
| Qualification | complete ABC/N campaign plus required evidence | Required. Only complete coherent runs count; a diagnostic/focal run, incomplete metrics or a successful run from another candidate cannot fill N. |
| Monetary estimate | dated tariff source + complete attributable usage by applicable model/tier | Optional. Label estimated; otherwise unavailable. Do not equate subscription quota/admission counts with billing or invent a price. |
| TTFT and per-tool time series | optional provider notifications | Optional; not needed for the requested comparison. No telemetry subsystem is introduced. |

The original defect discarded native notifications and returned null usage.
The corrected path projects notifications into existing event journals and
rebuilds deltas at export against the admitted ledger. The legacy SDK normalizer
is not used to reinterpret App Server data. Official 0.163.0 source establishes
the counter semantics; history Thread/Turn responses do not contain usage, so
missing historical tokens cannot be recovered from those reads. Delivery of all
child notifications on the real connection remains unproven. Synthetic fixtures
prove the consumer pipeline, not that historical/live notifications were emitted
or received. No paid proof is authorized by the offline work.

Offline acceptance covers source event → binding/normalization → existing
evidence persistence → export → comparison, with missing usage/child, duplicate
or late events, cumulative/reset semantics, failed retry then success, replay
and resume, incompatible cache semantics and missing cases/repetitions. A
complete positive fixture must have the expected identities and observations;
changing a coverage fraction alone never supplies missing evidence.

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
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --full --max-operations 6
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --case A
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --case A --max-operations 4
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --resume <focal-run-id> --max-operations 3
node benchmarks/sentinel-todo/runtime/benchmark-manager.mjs run --resume <stopped-full-run-id>
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
evidence without automatic measurement export or startup cleanup.
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
measurements belong in Git only after campaign qualification. Export standalone
reports for diagnosis or comparison into ignored temporary output, never directly
into `measurements/`. The standalone report writer also requires an explicit
diagnostic destination and refuses official history, including path aliases;
only campaign promotion can write that history. Both entrypoints use this
qualification boundary. Do not copy raw trees into
Git. Campaign startup retains previous scratch and its ledgers. Explicit cleanup
requires its own retention and safety gates. A fresh run recreates its runtime state from the versioned
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

For the native App Server 0.163.0 path, the numeric source is the separate
`thread/tokenUsage/updated` notification. `total` is a thread runtime counter;
`last` can describe one response or a context estimate and is never treated as
the turn total. Preserve projected snapshots, thread/turn identity and the
birth/baseline proof in the existing operation journal. Deduplicate identical
snapshots and replay; each received notification has one local observation ID
in that same journal, so rereading a preserved record is distinct from a newly
received lower counter. This is not a provider response ID or billing receipt.
Missing/conflicting observation identity is incomplete. Use a coherent cumulative difference only after terminal
notification. Count failed/interrupted attempts too. A fork, unknown baseline,
missing child notification, reset, changed late snapshot, persistence failure or
incomplete expected/observed matrix keeps the measurement incomplete. No new
model turn or silent child resume is used to obtain telemetry.

These are **observed runtime counters, not billed tokens**: the provider can
restore or synthesize counters. Reject detectable incoherence; do not claim
that this detects every synthetic value or proves an invoice. Cached input is
inside input; reasoning output is inside output. Missing values are never zero.
Child delivery on the real connection still requires a small runtime proof;
offline fixtures cannot establish subscription behavior. A complete export
requires its admitted main and child turns, including corrections, to have
attributable counters. A known partial subtotal stays labelled partial.

Native exports also retain SDK/CLI versions from the frozen snapshot and safe
model/service-tier/approval/legacy-sandbox acknowledgements from thread start/resume,
beside requested effort and the model/effort from each child's public binding.
An explicit null tier is recorded as unspecified, never inferred as default;
an absent field remains unknown. A legacy sandbox type is not an effective
permission-profile attestation. An acknowledgement is configuration evidence, not proof
of every underlying response's selected model or effort. Missing mandatory
acknowledgements prevent complete measurement. The frozen configuration/source,
seed and case hashes remain the comparison authority; no user configuration or
credentials are copied into the report. Run wall time includes its recorded
start/end interval, while summed case/operation durations are separate; an
administrative recovery gap is not invented as model execution time.

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

The historical initial comparison used one full run per configuration.
Current campaign defaults are N=3; preserve every report and summarize median,
minimum/maximum, and success rate without hiding outliers. Stop interpreting
G2/G3 when integrity fails, runs are incomplete, or the comparison contract
does not match. One sample checks function but does not establish a mature
statistical distribution. The versioned
`campaign.fullRuns` defaults to3 and can be overridden explicitly with `--runs N`. No
retrospective threshold is set from the reference run. Under the protocol's
historical pre-acceptance state, G2 and G3 stayed `PARTIAL` pending comparable
empirical evidence and an explicit gate decision. The later acceptance decision
is recorded in [`maintenance/p0-summary.md`](../../maintenance/p0-summary.md);
this protocol text does not describe the current P0 status. This change does not
start the campaign.
