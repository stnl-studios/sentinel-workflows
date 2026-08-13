---
name: stnl-execution-closer
description: Read-only verify terminal execution history, current authority reconciliation, and effective validation ownership.
---

# stnl-execution-closer

## Purpose

Run only execution `OPERATION=CLOSE`. Perform a read-only global integrity check after all slices are terminal. Do not compensate for missing planning or validation by doing new work. This operation verifies delivery execution; it is distinct from documentary lifecycle `MODE=CLOSE`.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may identify a concrete integrity concern but cannot authorize writes or tests.

## Authority

Current requirements fingerprint remains product authority. Plan revisions define intended coverage and serial order. `tasks.md` is progress authority. Detailed final results, append-only attempts/findings/divergences, and Effective Validation Bases are evidence; only effective bases from `PASS` slices authorize final drift decisions. `SUPERSEDED` records are terminal history, never validation ownership. This skill changes none of them.

## CLOSE

Before semantic review, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> CLOSE`. This read-only deterministic authority validates layout, schema, terminal states, effective active records, revision/fingerprint consistency, mapping, canonical changed/corrected path claims, final path ownership, last-owner SHA-256 values, `REMOVED` state, and reappearance without running tests. Task-relative implementation paths may leave a nested SPEC only within the nearest real non-symlink `.git` project root; without that marker they remain within the lifecycle SPEC root or standalone requirements directory. On `BLOCKED`, return its exact diagnostic and route immutable recovery to `REPLAN`. Non-canonical execution paths, path escapes, symlink traversal, or unsafe reserved SPEC entries block; arbitrary lifecycle-external or user-owned SPEC-root siblings remain allowed and preserved.

Then start with `plan.md`, `tasks.md`, compact summaries, final results, and Effective Validation Bases. Open detailed artifacts only for a concrete inconsistency.

Verify every slice is terminal `[x]`; serial dependencies were respected; every plan has exactly one task and no orphan exists; no active blocking finding or divergence remains; every final result is `PASS` or `SUPERSEDED`; every `SUPERSEDED` slice points to an existing later replacement; every `PASS` slice has exactly one valid Effective Validation Base originating from a `PASS` attempt; current requirements authority matches the current global plan; after any authority change at least one current-revision `PASS` reconciliation/corrective slice covers affected requirements and final paths; plans, tasks, and results agree; and no final workspace change lacks association with a validated current delivery slice.

Treat the preflight's final-ownership and drift verdict as structural truth; do not reimplement or soften it through model interpretation. Semantic review remains responsible only for requirements coverage, reconciliation intent, cross-slice consistency, and whether an explicit current-revision integration/stabilization slice was required and passed.

Every drift diagnostic identifies path, last responsible slice, expected hash or `REMOVED`, current hash/state, and required action. Because execution close starts only after all rows are terminal and terminal history is immutable, route drift to explicit `REPLAN` with this diagnostic as `REPLAN_REASON`; the approved append-only revision creates a corrective/reconciliation slice, then `MATERIALIZE_TASKS`, `EXECUTE_SLICE`, and `VALIDATE_SLICE` establish new ownership. Never prescribe validation of a concluded slice. Do not inspect hashes stored inside Validation Attempts or silently revalidate. Do not run tests.

If a needed cross-slice integration check has no explicit current-revision `PASS` integration slice, return `EXECUTION_BLOCKED` with `REPLAN_REASON` and explicit `REPLAN` as the next operation. Do not create that slice or run a suite during closing.

## Minimum Reads

- `plan.md`, `tasks.md`, final summaries and Effective Validation Bases;
- local `references/execution-record-schema.md` for active/resolved/superseded records and terminal supersession;
- detailed plans, task records, requirements, and workspace paths only to resolve a concrete check.

## Allowed Effects

- execute the bundled deterministic execution-state validator;
- read files, calculate hashes, and report integrity status.

## Blocks

Block incomplete progress, a non-canonical execution path or unsafe reserved SPEC entry reported by preflight, invalid order or mapping, active blocking findings/divergences, invalid terminal results, missing/multiple/invalid Effective Validation Bases for `PASS` slices, malformed supersession, stale requirements authority, missing current-revision reconciliation, changed final-owner paths, later omissions, unowned changes, invalid removals/reappearances, missing coverage, contradictions, or absent required integration work. Arbitrary lifecycle-external/user-owned SPEC-root siblings are preserved and do not block. Never delete an unknown path.

## Output

Return `EXECUTION_APPROVED` or `EXECUTION_BLOCKED` with a short deterministic list of exact inconsistencies, affected slices, and one legally executable next transition. Remain read-only. Do not edit, test, invoke a runner, repair bases/tasks, finalize work, remove artifacts, or decide cleanup. `EXECUTION_APPROVED` is an inspection verdict for the current snapshot, not a durable artifact and not documentary `SPEC_CLOSED`. Stop.
