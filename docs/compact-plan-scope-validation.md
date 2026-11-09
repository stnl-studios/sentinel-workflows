# Compact PLAN scope: bounded prevention of cascading revalidation

Base: `1030580a3b80fe10a55106fded25490515ae0fd5`. This change adjusts prospective author/reviewer guidance and adds synthetic tests. It changes no reader, evidence, cache, schema, recipe language or existing preparation.

## Cause and intervention

`execution-current-reader.mjs::observationRoots` combines Authorized Areas, Existing Inputs, Expected Files and typed recipe references, with retained in-domain leaves. `observeProduct` recursively captures a directory's membership. A later verifier added to a shared authorized directory therefore makes previous manifests stale even if the earlier actual checks never read it. This is correct for the approved broad contract, not a reason to drop freshness checks.

The prior planner said: “Existing directories may remain broad areas” and distinguished Expected Files as operational predictions. The prior reviewer checked dependency completeness, but neither specifically required examining accidental cross-slice observation before approving broad directories. The stock initial test fixture also uses `directory: src` for both deliveries. None of those instructions justified independent reuse.

The planner now says: “Prefer exact `file:` outputs over convenience-wide shared directories only after concrete inspection of verifier imports/configuration supports that boundary.” It also states: “Existing broad plans remain conservative; narrowing requires normal authorship, user approval and independent review, never rewriting historical evidence.” The reviewer requires concrete inspection, captures shared helpers, retains membership coverage and blocks unsupported proof claims. A short linked reference explains SQL Build Includes, Pre/PostDeployment, unknown SDKs and mutable-state limits. No automatic dependency completeness inference is added.

A structural validator cannot distinguish a convenience-wide directory from genuine implicit/glob membership merely because Expected Files is enumerated. Adding an automatic rejection or narrowing based on those fields would be unsound. The existing semantic author/reviewer boundary is used instead; no extra carrier or approval ceremony is introduced.

## Verification matrix

| Item | Change / observation | Test | Status |
|---|---|---|---|
| Accidental broad overlap | Exact outputs planned before approval | `compact PLAN` in `test-current-compact-plan.mjs` | PASS: two previous PASS proofs remain literal after controlled sibling addition; broad requires two physical revalidation processes, exact zero |
| Physical checks | Spy actual ChildProcess spawn arguments, not cached counters | Same test, official Initial installation and EXECUTE/formal verification | PASS: four initial physical checks per variant; broad two additional, exact zero |
| Shared helper | Real static import retained as Existing Input | Same test, mutate shared.mjs | PASS: both consumers stale in both variants |
| Directory membership | Actual readdirSync count, broad approved area | `real directory enumeration` | PASS: addition makes proof stale and direct physical check fails |
| Unknown input | Deliberately incomplete synthetic review omits environment input | `unknown environment input` | PASS as a negative control: freshness stays current while physical check fails. This disproves automatic independence, not an acceptance claim |
| Actual next slice | Planned missing exact outputs created during official third EXECUTE | `official third EXECUTE` | PASS: official third begin/verify/capture/publish creates the planned missing outputs; two prior PASS bundles and Tasks stay literal/current; one new implementation check and zero prior checks; legal handoff VALIDATE_SLICE03 |
| Terminal / contract change | No runtime exemption or proof promotion | Existing terminal and contract regression suites | Unchanged; this patch does not certify terminal acceptance |
| Packaging | Linked reference included without importing another installed skill | check-distributable-skills | PASS for planner and reviewer |
| Context budgets | Existing lifecycle ceilings | test-runtime-context-budget | PASS 4/4 with baseline objects available locally |
| Test discovery | New test deliberately catalogued | test-test-catalog | PASS 19/19 |

## Limits and RED/GREEN interpretation

The broad-versus-exact comparison is the RED/GREEN planning comparison: the broad plan incurs avoidable physical revalidation, the exact reviewed plan does not. Both preserve the existing freshness rules. Focused tests passed in separate runs: comparison 1/1 (also independently reproduced), unknown/membership 2/2, official third 1/1. The complete repository suite was not run. The tests use real official filesystem installation, reservation, verification, capture and publication, but synthetic semantic judgments, not real model acceptance or SQL Server.

An early experimental converted-current seed with exact file areas failed `EVIDENCE_INCOMPLETE: missing parent/child closure`. It was discarded rather than changing the reader or claiming old preparations could migrate. The final test uses the public Initial path and the existing synthetic approval helper. No production evidence was edited. Early negative-test harness runs also failed their oracle because nested `node --test` inherited NODE_TEST_CONTEXT; the oracle now removes it, matching the official verification helper.

No real SQL project's SDK, indirect imports, mutable database or local sqlcmd/DACPac environment was certified. Script hashes and declared dependency lists are insufficient to establish those dependencies. When the existing contract cannot observe a required mutable/unknown input, retain conservative coverage and block an unsupported independence/acceptance claim. Normal terminal proof remains required from the unique approved integral owner at the end of the queue. No RECONCILE was run.
