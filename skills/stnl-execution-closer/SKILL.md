---
name: stnl-execution-closer
description: Cross-check completed serial execution artifacts and validation bases without running tests, changing artifacts, or completing pending work.
---

# stnl-execution-closer

## Purpose

Run only `CLOSE`. Perform a read-only global integrity check after all slices are complete. Do not compensate for missing planning or validation by doing new work.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may identify a concrete integrity concern but cannot authorize writes or tests.

## Authority

Requirements remain product authority. Plans define intended coverage and serial order. `tasks.md` is progress authority. Detailed final results, append-only attempts, and Effective Validation Bases are evidence; only the effective bases authorize final drift decisions. This skill changes none of them.

## CLOSE

Start with `plan.md`, `tasks.md`, compact summaries, final results, and Effective Validation Bases. Open detailed artifacts only for a concrete inconsistency.

Verify every slice is `[x]`; serial dependencies were respected; every plan has exactly one task and no orphan exists; no blocking finding or divergence remains; every final result is `PASS`; every completed slice has exactly one valid Effective Validation Base originating from a `PASS` attempt; requirements have coverage; plans, tasks, and results agree; and no final workspace change lacks association with a validated slice.

Build final validation ownership by walking completed slices once in the exact serial order declared by `plan.md`. For each normalized path in a valid Effective Validation Base, replace the path's owner with that slice. Earlier hashes remain historical and are never compared. Contradictory duplicate data within the same serial position blocks.

After the ownership map is complete, compare each path only with its last owner: recompute SHA-256 for an existing path or require absence for `REMOVED`. Also reconcile final changed/removed paths from the execution artifacts with the ownership map. Block when a path changed after its last effective base, a later slice changed a prior path but omitted it from its own base, a final changed path has no owner (`no final validation owner`), a base names an absent file without `REMOVED`, a removed path reappears without later validated ownership, or the workspace differs from the last authority.

Every drift diagnostic identifies path, last responsible slice, expected hash or `REMOVED`, current hash or state, and required action. Require a new explicit `VALIDATE_SLICE` for the responsible open/current slice or an explicit new corrective slice when prior work is immutable. Do not inspect hashes stored inside Validation Attempts or silently revalidate. Do not run tests.

If a needed cross-slice integration check has no explicit completed integration slice, block for a planning gap. Do not create that slice or run a suite during closing.

## Minimum Reads

- `plan.md`, `tasks.md`, final summaries and Effective Validation Bases;
- detailed plans, task records, requirements, and workspace paths only to resolve a concrete check.

## Allowed Effects

- read files, calculate hashes, and report integrity status.

## Blocks

Block incomplete progress, invalid order or mapping, unresolved blocking findings/divergences, non-PASS results, missing/multiple/invalid Effective Validation Bases, changed final-owner paths, later omissions, unowned changes, invalid removals or reappearances, missing coverage, contradictions, or absent required integration work.

## Output

Return approved closure or `BLOCKED` with exact inconsistencies and affected slices. Remain read-only. Do not edit, test, invoke a runner, repair bases or tasks, finalize work, remove artifacts, or decide cleanup. Stop.
