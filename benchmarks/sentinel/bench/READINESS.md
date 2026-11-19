# Benchmark candidate: verified scope and remaining boundaries

## Implemented

- One command runs three independent tasks from the same clean Todo snapshot, with two repetitions, sequential admission, case/campaign limits and resumable checkpoints.
- GPT model and effort are configurable per task and per stage/actor. Requested configuration, effective case profile and observed configuration are recorded separately.
- App Server transport, immutable Sentinel source/engine snapshots, independent plan approval, native execution/validation, final CLOSE, baseline regression and external acceptance oracles.
- Response-ID-deduplicated reported tokens, cached input separately, unknown usage explicit, per-cycle evidence. No billing estimate or model ranking.
- Bounded no-progress, safe refusal of uncertain replay, synthetic interruption/effect reconciliation probes and independent verifier evidence.
- Controlled comparison refuses differing unrelated identities or incomplete observations. Diagnostic data never automatically enters official measurements.

## Commands (from the Sentinel repository root)

```sh
node scripts/run-benchmark.mjs validate-profile --profile benchmarks/sentinel/bench/profiles/qualification-case-stage.json
npm run benchmark:test
node scripts/run-benchmark.mjs run --profile benchmarks/sentinel/bench/profiles/qualification-case-stage.json --id UNIQUE_CAMPAIGN_ID --mode diagnostic
node scripts/run-benchmark.mjs status --id UNIQUE_CAMPAIGN_ID
node scripts/run-benchmark.mjs report --id UNIQUE_CAMPAIGN_ID
```

Do not repeat `run` to recover an uncertain attempt. Inspect its existing checkpoint and use the supported resume admission only if it permits continuation without resetting budgets. CLI/authentication and model availability must match the profile; no Claude corporate session is used. No main, global installation, remote, site or legacy results were changed.

## Live evidence: frozen engine 983069d

Import12 gate completed two slices, formal PASS, CLOSE, independent oracle and valid measurement admission. The complete diagnostic matrix then retained all six planned outcomes:

| Cell | Product outcome | Original measurement |
| --- | --- | --- |
| rename-1 | BLOCKED: no progress locating installed runtime | valid |
| query-1 | PASS, CLOSE, oracle PASS | valid |
| import-1 | PASS, CLOSE, oracle PASS | valid |
| rename-2 | PASS, CLOSE, oracle PASS | invalid: collector could not interpret quoted arguments / authorized TMPDIR handle |
| query-2 | BLOCKED: invalid Plan path carrier | valid original classification; unresolved capture effect remains |
| import-2 | BLOCKED: reviewed Plan not activated after truncated serializer output | valid |

Total reported usage: 33,891,776 tokens, including 30,553,344 cached input, 3,021,834 new input and 316,598 output. Sum of cell durations: approximately 129m40s. These are descriptive observations from two repetitions per task, not statistical model comparisons. No best-of selection or failed-run removal.

The execution coordinator in rename used Luna/medium; query used Sol/high with Sol/medium execution check; import used Sol/medium execution coordinator and Sol/high formal validation. Other defaults were Sol/high planning/review and Luna/medium checks unless overridden. The JSON profile is authoritative, including all actors and stage overrides.

## Subsequent observer correction

The quoted-literal lexer and authorized TMPDIR evidence handling were corrected prospectively, reviewed independently, and the complete local suite passed 354/354. These are observer-only changes; the frozen live execution above did not run this later engine identity.

A separate experimental offline analyzer preserves original results and identities. Five cells were reanalyzed with unchanged outcomes and token totals; only rename-2 recovered the missing execution-check attribution. Query-2 was explicitly NOT_ANALYZED because its checkpoint retains a pending capture effect. No old `harnessValid:false` was overwritten. This derived analysis is not an official qualification certificate and is not accepted by official admission.

Private byte-chain evidence recovers four native delivery envelopes from the preserved close-history, including exact response text, public capture hashes and plan approval bytes. Internal ownership material remains private; it is not part of a public result set.

## Remaining work before claiming full qualification

1. Do not claim that the current post-correction engine has completed a new live matrix. Existing execution evidence remains tied to 983069d.
2. Preserve query-2's uncertain capture side effects. The source runtime may copy/prune candidate data before refusal; no atomic rollback or safe replay has been established.
3. Official qualification remains blocked by the original invalid measurement and incomplete derived coverage. Keep official results empty rather than treating repaired observations as original execution evidence.
4. The two model-output/discovery failures and the serializer truncation are retained diagnostic outcomes, not proven Sentinel defects. They must not be hidden by retrying until PASS.
5. Synthetic recovery does not establish exactly-once behavior for arbitrary effects. Reported tokens may omit unflushed/in-flight observations; token guards are delayed observations, not guaranteed billing ceilings.

This is an implemented and tested benchmark candidate with a completed diagnostic matrix, not a claim of fully qualified production readiness.

## Repository packaging

The candidate is now source-controlled under `benchmarks/sentinel` on a real Sentinel work branch. The launcher materializes a verified copy inside `benchmark-temp/benchmark-v2` before execution or testing. Legacy results were preserved byte-for-byte with provenance, while retired benchmark runtime and exclusive tests were removed; shared central Sentinel tests were retained separately. Packaging checks are offline and are not a new live matrix for this packaged engine.

## Aggregate repository verification

The repository-wide run covered 119 test files, two tested delegations and structural validation. Its original report remains failed: 13 files failed; structure passed. Rechecks fixed five files without changing runtime guards: the benchmark's installed-path fixtures, installer destination assertions, documentary completion expectations and two textual workflow/runner contracts. The packaged benchmark suite subsequently passed 354/354; its consolidation scanner passed 19/19 and the three installer/contract files passed 27/27.

Seven files still cannot establish their non-Git cases with every temporary directory physically beneath this Git checkout. The runtime walks physical ancestors for `.git`; a Git ceiling environment variable does not change that boundary. These cases were also reproduced against the exact main snapshot in the same environment. They remain intact, not skipped or converted into Git cases. A genuinely non-Git filesystem environment is required to complete those checks; the current temporary-location constraint has not been relaxed. Therefore the aggregate suite is **not green**. These reproduced non-Git cases are a general-suite environment limitation, not a new benchmark-specific gate; non-Git support remains unchanged. Integration is not authorized by this verification. Original logs and main-snapshot comparison are private in `benchmark-temp`; a focused recheck does not overwrite a failed aggregate report.

The eighth previously grouped environment failure, `test-lifecycle-validator-adversarial.mjs`, was instead caused by long Unix socket paths. On the tested Node v22.20.0/Darwin environment, controlled probes at 120/135 bytes reported successful listen but created a socket at a truncated 104-byte path; shorter probes materialized the exact requested path. The unchanged test file passed **175/175, no skips**, with relative `TMPDIR=benchmark-temp/socket-audit`, keeping all files within the repository while shortening the socket address passed to the OS. The original aggregate failure remains unchanged. Its focused recheck is preserved privately in `benchmark-temp/socket-audit-relative.tap`; it does not remove the seven non-Git verification blockers.


## Packaged live verification

A single additional diagnostic task was executed through the real launcher at source commit `f61c920`: `npm run benchmark -- --id packaged-final-rename-01 --cases rename --repetitions 1`. Its frozen engine identity is `b6c4bde0a83722d323be6e29e5a6115ea16d0b308590bb271159c5f742566e7b`. No new six-cell matrix or official promotion was attempted.

The run finished **BLOCKED**, after five coordinator turns and 737,599 ms. INIT, readiness, planning and independent plan review advanced. The Luna execution coordinator successfully called `begin` and received the original handle, but did not persist it before stopping. Independent inspection confirmed a working Sentinel owner, no runner dispatch and no changes to the nine product fixture files. This is an observed executor/model operation failure, not demonstrated transport or Sentinel malfunction. The six observed configurations matched; measurement admission was valid diagnostic evidence, not task success. `benchmark:status` and `benchmark:report` successfully read the completed campaign.

The 67 unique observed responses total 2,474,492 tokens: 2,444,599 input, including 2,183,424 cached and 261,175 new input; 29,893 output, including 4,858 reasoning. Observed fields are complete for those records, but unflushed/unrecorded consumption cannot be excluded. A subsequent audit found that the result's `unreportedUsagePossible:false` incorrectly reflected only the absence of a pending coordinator turn. The original result remains untouched; the prospective correction now propagates usage uncertainty into reports and comparisons while retaining field completeness only for collected records. The complete packaged offline suite passed 359/359 after this correction, including fail-closed handling of absent or invalid totals. That correction was not part of the preceding live run.

The original handle is retained in recorded stdout, but the current benchmark has no proven automatic recovery path for this settled BLOCKED case with active Sentinel ownership and no saved handle file. Nothing was replayed, reconstructed, reset or cleaned out of that workspace. A successful current-engine end-to-end task, complete official qualification and exactly-once arbitrary-effect recovery are not claimed.


## Bounded receipt-preservation improvement

The execution prompt now explicitly requires a new private exclusive file for the original `begin` stdout, immediate readback, and a separate private JSON file containing exactly its `handle` field for the official `--handle` CLI argument. An already observed complete original receipt may be saved faithfully and inspected through official `resume`; it must not be inferred from state or regenerated by repeating `begin`. Missing, truncated or conflicting receipts remain blockers. Original deadlines, budgets and attempts are not renewed. Native dispatch stdout and verification environment rules are unchanged.

An offline proof used the real current Sentinel controller and synthetic test-only approved preparation in two fresh isolated Git fixtures. Both immediate saving and saving after observing original stdout used one `begin`, then official CLI `resume` returned `working` / `reserve-dispatch` for that same operation. Filesystem snapshots remained unchanged by resume; altered handles were rejected. Original receipts were private mode 0600. No model, recipe, dispatch or existing campaign recovery was executed. This proves the narrow official recovery mechanism, not generic exactly-once behavior or that a model will always obey the improved instruction. The earlier blocked diagnostic remains unchanged. Private proof: `benchmark-temp/begin-receipt-proof/report.json`.

After this prompt improvement, the complete packaged offline suite passed 360/360 with no skipped tests. No additional live campaign was run solely to obtain a passing outcome.

The subsequent single live `packaged-receipt-rename-02` run used commit `27440f8` and stopped at the existing no-progress limit after 841,558 ms and seven turns, before `begin`. The executor searched the product's runtime directory rather than the installed skill's controller, despite reading the skill. Independent audit confirmed matching installed hashes, untouched nine-file product baseline, pristine authority and zero execution counters. It observed 2,433,655 tokens (2,139,520 cached input, 258,723 new input, 35,412 output); consumption uncertainty was correctly retained. This failure remains diagnostic, not discarded. A subsequent prompt clarification now supplies the exact absolute installed SKILL and controller path per execution/validation/close stage; missing or unreadable controllers still block rather than triggering substitutes or dependency installation.

The single `packaged-controller-rename-03` run progressed through published execution checks and formal NEEDS_FIX, then stopped during APPLY_FINDINGS. Its coordinator saved a child's `finalResponse` as a JSON object rather than the required original string. An independently audited, explicitly recorded intervention within the original deadline preserved the rejected envelope and captured a new envelope containing the exact original completed-child string; official capture returned TESTS_PASS without replay, and official resume confirmed captured/publish for the same owner. No recipe, dispatch or begin was repeated. No publication was performed during that intervention; the finding still lacked correction, so this is not task PASS or autonomous recovery. Original results remain untouched. The prompt now explicitly requires literal-string `finalResponse` and confirmed native completion.

A separately named `reference-sol-high.json` profile fixes every role to GPT-6.1 Sol/high for pipeline qualification. It retains the same source, fixture and limits but is not equivalent to the mixed profile. Mixed-profile failures remain observations; a future reference PASS will not establish robust support for the mixed profile. The default profile is unchanged.

## Reference profile live result

`reference-rename-01` completed autonomously despite a host connection interruption: eight coordinator turns, 1,605,197 ms, formal PASS followed by SPEC_CLOSED, independent oracle 4/4 acceptance and 8/8 frozen regressions. Source/engine/profile/fixture/runner hashes and all ten observed configurations matched; 155 unique responses sum to 7,756,288 reported tokens (7,059,072 cache, 634,777 new input, 62,439 output). In-flight/unflushed usage remains unknown; these are not billed-token totals. The reconnect attempt refused CAMPAIGN_LOCK_ACTIVE without dispatch because the original process had survived; no duplicate execution was launched.

Independent audit recovered both literal child delivery envelopes under the authorized cell TMPDIR and matched them against native final strings and official capture hashes. The original communication collector had only accepted workspace paths. Its prospective correction explicitly accepts that cell's canonical sibling `temp` directory, refuses symlink/traversal/other-cell paths and reads only tool-result files referenced by successful official captures, rather than scanning temporary files. The original run and its collector output remain immutable; any reanalysis is separately identified. The complete offline suite passed 366/366 after this collector correction. The execution engine identity of the original run must not be relabeled as the later analyzer identity.

## Consolidated functional validation

All three reference tasks completed PASS/CLOSE with independent audits. The bounded framed-copy contract observer correction passed the complete 368-test suite; separately identified reanalysis proves all four import contract reads while preserving its original invalid admission. See [consolidated validation and explicit limits](../VALIDATION.md). No official certificate or automatic promotion was issued.

## Single default mixed campaign and bounded follow-up

`mixed-full-01` ran the unchanged default mixed profile, all three tasks with two repetitions, via one packaged command at `f0cb309`. It ended with two PASS/CLOSE cells (query-2 and import-2) and four BLOCKED cells, all preserved. The original process survived host disconnection; its dead launcher lease was archived only after the parent PID and process group returned ESRCH. Independent audit verified both PASS cells' configuration, contract, communication and source hashes. Total reported usage was 32,827,418 tokens including 29,878,016 cached input; usage gaps remain explicit. This is not a full mixed-profile qualification.

The four failures separate authoring/contract-use errors from transport: draft readiness carriers rejected by technical review, CLI argument notation rejected as a placeholder at successive locations, an independent verifier invoking a nonexistent helper rather than the reserved path, and a coordinator skipping implementation followed by an invalid semantic runner response. None was changed into a valid product result. Original evidence and the private causal audit remain in the campaign directory.

Prospective changes stay narrow: clarify structural PLAN readiness versus independent approval; after official invalid-image refusal, correct the error class across the same draft allocation rather than only its first occurrence, retaining two retries and existing recovery guards; pass the official reservation's helper/origin/request paths literally in native handoff. There is no parser replacement, automatic document rewriting, verification wrapper, inferred receipt, relaxed guard, model substitution or generic recovery from technical review rejection. A model can still fail to follow the contract. The full offline suite passes 371/371. These changes were not present in mixed-full-01 and require prospective live evidence.

Only `.git` metadata for the two PASS workspaces was archived, extracted and compared before removal. Products and all evidence hashes were preserved; BLOCKED cells were untouched. Restore information is under `evidence/cleanup/mixed-full01-pass-git/` inside benchmark-temp.

The first prospective attempt `mixed-fixes-rename-01` stopped during zero-model environment preflight (exit 71). Its stderr hash exactly matched `sandbox-exec: sandbox_apply: Operation not permitted`; a zero-model probe reproduced the nested outer-sandbox failure. The authorized escalated launcher passed the same probe and retained the benchmark's inner workspace-write, no-network sandbox. A new isolated `mixed-fixes-rename-02` attempt at `992a64d` passed preflight and ran six turns, but stopped with SENTINEL_AUTHORITY_BLOCKED after 1,208,502 ms and 3,419,857 observed tokens (3,004,288 cached input). The product remained unimplemented according to the runner; no success is claimed. Both attempts remain intact. This live diagnostic does not qualify the mixed profile and no further full matrix was launched to seek a green result.

## Explicit reference-default decision

Following the completed mixed campaign and bounded diagnostic, qualification now explicitly defaults to the existing `reference-sol-high.json`: GPT-6.1 Sol/high for all roles, three tasks, two repetitions. The mixed profile remains selectable with all task/stage configuration flexibility and failures intact. This is a technical choice based on repeated observed execution omissions, not a general claim that Luna is incapable or a statistical model ranking. No further prompt patch was added to force an outcome. The new default must pass its own real campaign; it cannot inherit success from earlier separate reference runs or be compared as if it were the same mixed configuration. Offline: 371/371 core and 13/13 launcher PASS.

## Prospective task-specific observed-token calibration

The existing case override surface now accepts only `limits.maxReportedTokens`, an explicit positive safe integer bounded by the campaign cap when present. The reference-v2 profile uses import14M and rename/query12M; time remains40min per case, campaign4h/60M, maxTurns20 and no-progress2. Effective profile identity records the selected limit. No model or acceptance criterion changed, and cached tokens remain in raw operational volume rather than being treated as free or as a billing estimate. Tests cover strict rejection, precedence, isolation, identity and real budget/monitor behavior, including unchanged deadlines. Full offline375/375 and launcher13/13PASS. One new standard-command acceptance campaign is authorized; no certification/promotion/publication and no automatic subsequent retries or budget increases.

## Reference-v2 single-command acceptance outcome

`acceptance-reference-v2-01` at `0d6871b` completed all six planned cells in 3h08m30.809s: five PASS/CLOSE/oracle and one import-1 CASE_DEADLINE at40min. Import-2 passed in37m11 with12,028,066 observed tokens; import-1 stopped at11,744,470, so the new14M token cap did not solve its latency constraint. Total55,399,520 includes50,857,088 cached input,4,086,647 new input and455,785 output; unflushed usage remains explicitly unknown. No new run or increase followed this failure. Full qualification remains unmet, and experimental results cannot be combined with the isolated counterproof into a six-cell PASS. See VALIDATION.md for causal timing and the explicit prospective decision. Official execution on an authorized integrated main commit and a separate results-only PR remain future work.

## Prospective watchdog calibration v3

The same case override configuration now accepts caseMs as well as maxReportedTokens; unknown/global overrides and invalid integers are rejected, with turnMs <= caseMs <= campaignMs. Reference-v3 changes only import to50min, keeping rename/query40min, import14M/others12M and global4h/60M. Existing deadline min(case,campaign) and aggregate token guards remain authoritative; global censoring is intentional even though cell maxima sum to260min/76M. Forty minutes is a diagnostic duration reference, not a functional acceptance gate. Offline377/377 and launcher13/13 PASS before one authorized new full campaign; no automatic rerun/increase after failure.

## Watchdog-v3 acceptance outcome

Single standard-command `acceptance-watchdog-v3-01` completed six cells:5PASS/CLOSE/oracle and import1 blocked by14M observed-token guard at47m20. Import2 completed44m42, exceeding the diagnostic40min reference but within50min. Total59,812,888 observed tokens and3h23m31.768s stayed within unchanged60M/4h campaign caps, with narrow187,112-token margin. Import1 included a legitimate failed-test correction and second independent check, not historical formal replay. No subsequent run/increase; full six-cell success remains unproven. Original outcomes remain experimental and immutable.
