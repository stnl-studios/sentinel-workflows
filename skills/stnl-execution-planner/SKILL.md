---
name: stnl-execution-planner
description: Create or explicitly replan a compact serial execution strategy from a fingerprinted requirements authority.
---

# stnl-execution-planner

## Purpose

Run exactly one operation: `PLAN` or `REPLAN`. Convert an authoritative requirements source into a strictly serial delivery strategy without creating tasks, implementing, testing authoritatively, or approving the result.

## Inputs

- `SPEC_PATH`: required. Normalize it with `references/workspace.md`.
- `REPLAN_REASON`: required only for `REPLAN`. It is the compact persisted or returned diagnostic, or explicit user-authorized reason, that requires a planning change. It cannot replace requirements authority.
- Optional additional context may narrow this operation but cannot change requirements, scope, dependencies, or authority.

## Authority

The normalized requirements source remains authoritative and unchanged. Compute its canonical `stnl-requirements-authority-v1` SHA-256 fingerprint before planning and persist exactly `- Requirements authority: sha256:<64hex>` and `- Plan revision: <positive integer>`. This skill may create or revise only `plan.md` and `plans/slice-NN.md` below the derived execution root. `REPLAN` may also stage the precise task-history transitions later committed atomically by `MATERIALIZE_TASKS`; it never mutates tasks itself. Persist every path relative to the artifact containing it.

## PLAN

Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> PLAN`. Ignore `__MACOSX`, `.DS_Store`, and `._*` when deciding whether a directory is empty. `PLAN` is allowed only when the root is absent or contains no other entries. If any recognized planning or execution artifact exists, return `BLOCKED`, list it, preserve every byte, and name the operation compatible with the observed state. Unrelated execution-root content is also a collision and blocks. Reset is not a PLAN behavior.

Read `references/workspace.md`, the requirements needed for coverage, shallow project structure, and only code or tests directly needed to understand impact. Define observable, testable slices in strict serial order. Record explicit dependencies, requirement coverage, included and excluded scope, boundaries, risks, likely areas, expected tests, and integration needs. Avoid microtasks and broad slices.

If several slices require real integration verification, add a final explicit integration or stabilization slice. Do not defer that verification to closing.

Create `plan.md` and every foreseeable `plans/slice-NN.md` using the templates. Set each File Purpose Header status to `draft`; this means planning exists but independent review has not approved it.

## REPLAN

Require explicit `REPLAN_REASON`. Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> REPLAN`. Derive recovery mode solely from deterministic execution state; never accept a caller-selected reset or extension mode. Recompute the current requirements fingerprint before any proposal. If a product decision or documentary change is still required, return a lifecycle `RESUME` handoff without drafting.

When the complete task set is `MATERIALIZED_PRISTINE`, build one full replacement plan set in isolation. Preserve the source and every unrelated byte while rendering. The later materialization commit may atomically replace only the canonical plans and pristine task set, returning execution to draft planning. This is the only state in which existing plan or task artifacts may be replaced or removed.

After any operational evidence exists, history is immutable. Preserve every existing detailed plan, detailed task, Validation Attempt, finding, divergence, Effective Validation Base, final result, and prior requirements fingerprint byte-for-byte. Increment the global plan revision and append monotonically numbered corrective, replacement, reconciliation, or integration slices only. A replacement proposal identifies each open prior slice it supersedes. A prior `PASS` remains `PASS`; an open superseded slice is terminalized only when approved extension tasks are committed by `MATERIALIZE_TASKS`.

New slices carry the current requirements fingerprint and revision. Historical slices retain their original values. After requirements authority changed during execution, supersede every non-terminal slice carrying the older fingerprint and replace it under the current revision. Include at least one current-revision reconciliation or corrective slice covering affected requirements and final paths, including relevant historical PASS effects; never treat prior validation under an older fingerprint as current authority.

Render the pending replacement or extension with `draft` status and pending review. Return `REPLAN_DRAFT` and require `REVIEW_PLAN`; never approve or materialize it here.

## Minimum Reads

- `references/workspace.md`;
- normalized requirements source and directly referenced requirement records;
- `templates/plan.template.md` and `templates/slice-plan.template.md` when writing artifacts;
- existing plans, task index, and only the task sections needed to classify pristine replacement versus append-only history for `REPLAN`;
- shallow structure and directly relevant implementation areas only.

## Allowed Effects

- create the derived execution root when safe;
- create `plan.md` and the complete `plans/slice-NN.md` set once, only from `EMPTY`;
- on explicit `REPLAN`, draft either an atomic pristine replacement or append-only revision/extension as determined by state;
- report coverage and concrete uncertainty.

## Blocks

Block without writes when inputs or execution state are invalid, `PLAN` sees a non-empty root, the requirements fingerprint cannot be computed, requirements are insufficient for deterministic planning, or a product decision is required. Return ambiguity to the requirements owner; do not invent an answer. `REPLAN` must never reset after operational evidence or modify historical artifacts.

## Output

Report operation, status (`REPLAN_DRAFT` for successful `REPLAN`), current requirements fingerprint, plan revision, created or proposed paths, supersession mappings, slice order, coverage, material risks, and that `REVIEW_PLAN` is required. Stop.
