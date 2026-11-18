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

Eight files still cannot establish their non-Git cases with every temporary directory physically beneath this Git checkout. The runtime walks physical ancestors for `.git`; a Git ceiling environment variable does not change that boundary. These cases were also reproduced against the exact main snapshot in the same environment. They remain intact, not skipped or converted into Git cases. A genuinely non-Git filesystem environment is required to complete those checks; the current temporary-location constraint has not been relaxed. Therefore the aggregate suite is **not green** and this candidate is **not ready to integrate**. Original logs and main-snapshot comparison are private in `benchmark-temp`; a focused recheck does not overwrite a failed aggregate report.
