# Test suite execution audit (2026-11-08)

## Coverage-preserving changes

- The launcher contract and validation-runner contract Node suites still execute in full, once each.
- Their shell entry points no longer execute those same complete suites a second time during `npm test`. Each is explicitly catalogued as a delegation with a target, covering test and reason.
- The delegation tests exercise each unchanged shell entry point with a recording Node substitute. They check exact arguments, repository-root resolution from another working directory, paths with spaces, success, propagation of exit 23 and the missing-Node failure.
- The launcher positive control calls the checker once and asserts that same result, instead of spawning it twice while constructing an assertion.
- Missing, stale, unsorted, duplicate, unexplained and overlapping catalog entries fail closed. Delegations require a separately runnable target and covering test. The existing prepared benchmark fixture remains the only fixture exclusion.
- No runtime scenario was removed or moved behind an optional flag. Execution remains sequential; no claim of cross-suite isolation is used to enable parallelism.
- Every executed test file and structural validation produces a JSON status, exit code and duration. Delegation and excluded-fixture records are explicitly marked and do not pretend to have run another suite.

## Preliminary representative measurement

Both measurements ran on the same Linux host, Node v24.22.1, against the imported baseline and isolated integration. Other regression work and the full baseline were active, so these timings are observations under contention, not a controlled full-suite speedup claim.

Baseline workload: launcher Node suite, launcher shell wrapper, validation-runner Node suite, validation-runner shell wrapper.

- Launcher Node: 2.272 s.
- Launcher wrapper repeating its suite: 8.421 s.
- Validation-runner Node: 43.078 s.
- Validation-runner wrapper repeating its suite: 22.338 s.
- Total observed: 76.109 s, 110 assertions reported across the four suite executions (55 unique Node tests repeated twice).

Initial optimized workload: both Node suites once, plus delegation, catalog and runner regression files.

- Launcher Node: 2.015 s.
- Validation-runner Node: 42.650 s.
- Delegation contracts: 0.241 s.
- Catalog regressions: 0.182 s.
- Runner regressions: 4.711 s.
- Total observed: 49.799 s, a 26.310 s reduction in this representative workload. This first measurement included 25 new regression tests. Two further delegation-result regressions were subsequently added; the complete new regression group passed 27/27 in 3.980 s when run together.

The deterministic reduction is two redundant full suite invocations plus one redundant checker invocation. This alone does not establish a material percentage improvement over a 74–90 minute full suite. Full-suite baseline/integration duration and success must be reported separately after both finish.

## Comparable full-suite prerequisites

The first baseline attempt was stopped as an invalid preflight, with its failure log retained. It exposed setup issues, not evidence of a passing baseline:

- The archived source needed isolated Git metadata for environment-preservation tests.
- Both repository and `agents/codex` locked dependencies are required (`npm ci --ignore-scripts --no-audit --no-fund` in each directory).
- Temporary storage must be on the same filesystem as the checkout because existing measurement tests use rename between fixture roots.
- Existing product-oracle tests expect TAP `# pass` summaries; Node 24 otherwise emits the spec reporter. The initial diagnostic setup injected a global TAP option. Later private-recipe tests exposed why that is unsafe: explicit recipe reporters combine with the environment option. The final test setup instead requests TAP only in the two oracle subprocess argv lists and does not inject a global reporter.

After correcting setup, all five targeted prerequisites passed: environment E01/E02/E04 and the A/B product-oracle positive controls. The immutable full baseline was restarted with identical source bytes, TAP output and same-filesystem temporary storage. The external recorder captures each file duration and the final exit status.

For the final full run, set `TMPDIR` to an existing directory on the checkout filesystem and `SENTINEL_TEST_REPORT` to an external JSON destination. Do not set a global `NODE_OPTIONS=--test-reporter=tap`; the per-file JSON report does not depend on the human-readable reporter. The test command remains `npm test`; no timeout, skip or narrowed pattern substitutes for its completion.

## Baseline failure retained and separate fixture stabilization

The corrected full baseline recorded a failure in `test-app-server-transport.mjs`: the `duplicate-admission` fixture exceeded its 1000 ms initial-observation deadline before reaching the replay-integrity mutation. The failing case took approximately 1208 ms; an exact unchanged-baseline recheck passed in approximately 476 ms. The full-run failure remains part of the baseline result and is not replaced by that recheck.

The same continuation fixture later exposed a valid reobservation exceeding its 1000 ms budget during preservation I/O. All non-temporal variants in this one continued-provider family now allow 5000 ms to reach their conclusion or targeted integrity mutation. The expired and expired-during-admission variants retain 1000 ms, their expired deadline/2000 ms clock advance and rejection assertions. Production and global timeouts are unchanged. The complete transport file passed 580/580 and the separate deadline/expired selection passed 16/16 in an isolated copy. These are fixture stabilizations, not suite speedups; the original full-run failures remain recorded.

## Validation checkpoint after the final repairs

The corrected baseline was stopped after 44 minutes 47 seconds with 15 files concluded and the recorded duplicate-admission failure. It is explicitly incomplete/failed; there is no completed baseline duration or full-suite speedup percentage. The earlier e7b1455, a63c9fe and 0cb3a66 candidate runs were superseded and retained as partial evidence. The 0cb3a66 run recorded the valid-reobservation fixture timeout before being stopped. The a63c9fe run was stopped before its known CLOSE documentation budget failure; the documentation was shortened without raising ceilings or removing operator safeguards.

A broad preflight also reproduced an unchanged-baseline Node 24 fixture incompatibility: `fs.stat(..., {throwIfNoEntry:false})` returns undefined for an absent path, while the test expected null. Only the fixture now uses an ENOENT-specific rejection assertion. It still rejects a present obsolete directory and no longer hides unrelated filesystem errors. The fixed file passed all 18 tests in an isolated copy. The checkout also needs the exact historical Git object named by the existing context-budget manifest, not merely the current source snapshot.

The final frozen candidate requires its own complete result. See the separately delivered verification report for the eventual status; this document records the measured work removal and validation setup rather than asserting acceptance.

The 5abe6b3 run remains diagnostic. Its private-review failures were reproduced on the unchanged baseline under the same global reporter environment; they are not evidence that the production runtime should accept failed checks. The follow-up changes only tests and documentation, and keeps all runtime environment/provenance checks intact.
