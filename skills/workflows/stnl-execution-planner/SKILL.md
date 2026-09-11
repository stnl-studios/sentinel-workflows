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

The normalized requirements source remains authoritative and unchanged. Compute its canonical `stnl-requirements-authority-v1` SHA-256 fingerprint before planning and persist exactly `- Requirements authority: sha256:<64hex>` and `- Plan revision: <positive integer>`. This skill may create or revise only `plan.md` and `plans/slice-NN.md` below the derived execution root. Before tasks exist, `REPLAN` replaces only the unmaterialized planning authority. After tasks exist, it may stage the precise task-history transitions later committed atomically by `MATERIALIZE_TASKS`; it never mutates tasks itself. Persist every path relative to the artifact containing it.

Render the complete model-authored planning set in an isolated operating-system temporary candidate, then execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>` before publication. Candidate invocation and publication ownership are contract/model enforced; the runtime strictly parses the candidate but is not a publisher. A rejection preserves all live bytes. Publish only the authorized planning paths after PASS, then perform the operation-specific strict readback below.

Execution preflight is read-only. Only when it reports a mechanical violation for the exact `Findings IDs` alias or the exact historical `Check discovery sources` / `Check discovery actions` pair may this skill explicitly run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --repair-known-contract` once and repeat the original preflight; every other contract violation blocks.

## PLAN

Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> PLAN`. Ignore `__MACOSX`, `.DS_Store`, and `._*` when deciding whether a directory is empty. Structural inspection may report lifecycle `draft|blocked + EMPTY`, but PLAN is legal only for lifecycle `ready + EMPTY` or standalone `EMPTY`. An exact official historical lifecycle-root execution signature blocks as legacy before EMPTY classification. If any recognized planning or execution artifact exists, return `BLOCKED`, list it, preserve every byte, and name the operation compatible with the observed state. Unrelated execution-root content is also a collision and blocks. Reset is not a PLAN behavior.

Read `references/workspace.md`, the requirements needed for coverage, shallow project structure, and only code or tests directly needed to understand impact. Form slices from outcomes before considering implementation work. The canonical principle is: a Slice is the smallest cohesive, observable, and validatable milestone that must be implemented and preserved as one unit.

For each candidate, use Business (what capability or behavior exists), UX/Design (which user-visible interactions and states belong to that behavior), Architecture (contracts, persistence, integration, security, migration, and structural boundaries), and Engineering (the work that implements it) as completeness lenses. These lenses guide reasoning only; do not add persisted `business`, `design`, `architecture`, or `engineering` fields. Engineering work normally becomes Tasks inside the Slice.

Create a new Slice only for a material semantic or operational boundary: an independent capability or outcome; an observable milestone that can be validated on its own; a real dependency that requires an earlier delivery; a relevant architectural boundary; a migration, expand/migrate/contract, cutover, rollout, or compatibility transition with a real intermediate state; an independently rollbackable risk; cross-slice behavior; or a security, performance/SLO, observability, certification, load, or compatibility milestone when that is the SPEC objective. A frontend/backend/API/database/persistence/security/tests/telemetry/integration layer change alone is not a boundary. Do not split for task count, files touched, apparent size, technical complexity, or agent/context limits.

Challenge an over-sliced candidate by merging layer-only or handoff-heavy candidates when they are not independently meaningful, depend strongly on one another to produce the first validatable behavior, or increase integration work without preserving a real boundary. Challenge an over-merged candidate by splitting independently observable outcomes with distinct lifecycle, contracts, state, validation, risk, rollback, or delivery dependencies; thematic affinity alone is not enough to merge them. Do not introduce an ideal, minimum, maximum, or target number of Slices; one unitary SPEC may legitimately have one Slice and a complex SPEC may need several.

Keep shared primitives with the first Slice that actually consumes them and make ownership explicit. A Foundation Slice is valid only when it is itself an independently observable milestone. Tests, telemetry, and ordinary integration complete the owning vertical Slice. A separate Integration, Stabilization, Tests, Telemetry, Cleanup, Follow-up, or similar Slice requires an explicit independent cross-slice or operational milestone that cannot be validated in the owning Slice; never use one as a generic work deposit.

Do not hide a bad SPEC boundary in several otherwise plausible Slices. If the authoritative requirements assessment says `MULTIPLE`, `AMBIGUOUS`, or otherwise identifies independent product capabilities, use the existing requirements-refinement, lifecycle `RESUME`, roadmap, or replan handoff instead of treating Slice multiplication as proof of a healthy SPEC. Reuse the existing `UNITARY`/`MULTIPLE`, `capability_count`, and `decomposition_value` authority when present.

Define observable, testable slices in strict serial order. Record explicit dependencies, requirement coverage, included and excluded scope, boundaries, risks, likely areas, expected tests, and integration needs. Before publication, maintain an in-memory coverage ledger for requirements, acceptance criteria, decisions, constraints, risks, contracts, and other current authorities: split, merge, and reorder must preserve the canonical reference set and ownership/consumption/validation distinction. Recompute the dependency graph after every transformation, reject unknown or circular dependencies, and ensure every dependency precedes its consumer in Serial Slice Order. Never copy old dependencies blindly.

Create `plan.md` and every foreseeable `plans/slice-NN.md` using the templates. Set each File Purpose Header status to `draft`; this means planning exists but independent review has not approved it.

## REPLAN

Require explicit `REPLAN_REASON`. Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> REPLAN`. Derive the exact one of three mutation classes solely from deterministic execution state: planning exists with tasks absent, tasks exist and are wholly pristine, or operational evidence/history exists. Never accept a caller-selected reset or extension mode. Recompute the current requirements fingerprint before any proposal. If a product decision or documentary change is still required, return a lifecycle `RESUME` handoff without drafting.

When planning artifacts exist but neither `tasks.md` nor `tasks/` exists, they are mutable unmaterialized authority, not historical execution state. Build one complete replacement planning set in isolation and atomically replace exactly `plan.md` plus the detailed plans named by its Serial Slice Order. Remove obsolete canonical detailed plans in the same publication so no competing planning authority survives. Keep Plan revision `1`; omit `Revision mode`, `Replan reason`, and `Supersedes open slices` because those fields describe recovery from materialized history. Apply the same outcome-boundary, coverage, and dependency review to the replacement. Publish the replacement as draft/pending review, return to `PLANNED_DRAFT`, and require the normal `REVIEW_PLAN` then initial `MATERIALIZE_TASKS` flow. Do not create an append-only recovery revision merely because planning files existed.

When the complete task set is `MATERIALIZED_PRISTINE`, build one full replacement plan set in isolation. Preserve the source and every unrelated byte while rendering. Use the existing increasing revision with `Revision mode: pristine-replacement`; the later materialization commit may atomically replace only the canonical plans and pristine task set, returning execution to draft planning. This is the only state in which materialized task artifacts may be replaced or removed.

After any operational evidence exists, history is immutable. Preserve every existing detailed plan, detailed task, Validation Attempt, finding, divergence, Effective Validation Base, final result, and prior requirements fingerprint byte-for-byte. Increment the global plan revision and append monotonically numbered corrective, replacement, reconciliation, or explicitly required cross-slice/operational milestone Slices only. A replacement proposal identifies each open prior slice it supersedes. A prior `PASS` remains `PASS`; an open superseded slice is terminalized only when approved extension tasks are committed by `MATERIALIZE_TASKS`.

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
- on explicit `REPLAN`, atomically replace planning-only authority, draft a materialized-pristine replacement, or stage an append-only recovery extension as determined by state;
- report coverage and concrete uncertainty.

## Blocks

Block without writes when inputs or execution state are invalid, `PLAN` sees a non-empty root, the requirements fingerprint cannot be computed, requirements are insufficient for deterministic planning, or a product decision is required. Return ambiguity to the requirements owner; do not invent an answer. `REPLAN` must never reset after operational evidence or modify historical artifacts.

## Output

After successful publication, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after <OPERATION>`. Report operation, status (`REPLAN_DRAFT` for successful `REPLAN`), current requirements fingerprint, plan revision, created or proposed paths, supersession mappings, slice order, coverage, material risks, the runtime's normal handoff, and every legal operation in the resulting state. A successful `PLAN` normally hands off to `stnl-plan-reviewer / OPERATION=REVIEW_PLAN`; legal `REPLAN` remains separate. Stop.
