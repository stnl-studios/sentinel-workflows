---
name: stnl-plan-reviewer
description: Independently review and directly correct an initial plan or pending recovery revision before task commitment.
---

# stnl-plan-reviewer

## Purpose

Run only `REVIEW_PLAN`. Perform an independent critical review of the initial plan or one pending `REPLAN` revision, correct only the mutable draft set, approve a coherent result, and stop.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may identify a concrete concern but cannot change requirements.

## Authority

Requirements and their current computed fingerprint remain authoritative. This skill may change only the mutable draft global plan and detailed plans. Historical revisions and slice plans carrying an earlier revision are immutable. It cannot create tasks, edit code, resolve documentary ambiguity, or commit supersession.

Execution preflight is read-only. Only when it reports a mechanical violation for the exact `Findings IDs` alias or the exact historical `Check discovery sources` / `Check discovery actions` pair may this skill explicitly run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --repair-known-contract` once and repeat the original preflight; every other contract violation blocks.

## REVIEW_PLAN

Before content reads, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> REVIEW_PLAN`. Run only when there is a draft initial or planning-only replacement plan, or a pending materialized `REPLAN` revision/extension. It may be repeated while that draft remains mutable. A planning-only replacement is revision `1`, has no historical recovery fields, and follows the same review gate as an initial plan. Existing task artifacts do not by themselves block review: in pristine replacement mode, review the full replacement set; after operational evidence, review only the append-only revision and new slices while preserving all historical plan/task artifacts byte-for-byte.

Apply review corrections only to an isolated complete execution candidate and execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>` before publication. This contract/model-owned invocation gives the runtime strict parsing authority, not publication authority. Candidate rejection preserves live bytes; after successful candidate validation, publish only the authorized planning paths and use the final handoff command as strict readback.

Check the following explicitly and deterministically: (1) Slice boundary; (2) verticality; (3) cohesion; (4) independence of outcomes; (5) over-slicing; (6) over-merging; (7) artificial technical slicing; (8) artificial Foundation slicing; (9) artificial Integration/Stabilization slicing; (10) complete canonical coverage; (11) dependency validity; (12) strict Serial Slice Order; and (13) the SPEC boundary when applicable. Also check missing owners, overlap, public contracts, persistence, migrations, authentication and authorization, external integrations, shared state, breaking changes, architectural risk, expected tests, implicit work, accidental scope, and consistency between global and detailed plans.

Apply this decision sequence. First reconcile the candidate with the authoritative requirements/refinement assessment and preserve the union of current requirements, acceptance criteria, decisions, constraints, risks, contracts, and other relevant obligations; do not invent coverage or silently transfer authority. Then review every Slice as an outcome/milestone: its observable result, UX states, architectural boundary, lifecycle, validation, risk, rollback, and dependency must form one coherent unit. Engineering layers such as frontend, backend, API, database, persistence, tests, telemetry, security, and integration normally stay as Tasks within that vertical Slice. Many Tasks, files, or technical areas are not evidence for a split, and agent/context capacity never determines a semantic boundary.

Merge candidates that are only layer-based, not independently meaningful, or strongly coupled until the first validatable behavior. Split candidates only when they contain independently observable outcomes or real lifecycle, contract, state, validation, risk, rollback, migration, cutover, rollout, compatibility, or dependency boundaries; thematic affinity alone does not justify a merge. A technical Slice remains valid for a genuine migration, rollout, cutover, compatibility transition, security/performance/observability objective, or certification/load/compatibility campaign. Do not use a Slice count, maximum, minimum, or target as a review criterion.

Keep shared primitives with the first real consumer and reject a Foundation Slice without its own milestone. Keep tests, telemetry, and ordinary integration inside the owning Slice. Permit a separate Integration or Stabilization Slice only for explicit cross-Slice behavior or an operational milestone that cannot be validated earlier; reject generic Tests, Telemetry, Cleanup, Follow-up, or remaining-work deposits. If the SPEC itself contains multiple product capabilities, use the existing `UNITARY`/`MULTIPLE`, `capability_count`, `decomposition_value`, requirements-refinement, lifecycle `RESUME`, roadmap, or replan authority rather than hiding the boundary in multiple Slices.

After any split, merge, or reorder, derive the dependency graph again, reject unknown/self/circular edges, require dependencies to precede consumers, and verify that the global table, detailed plans, downstream references, and Serial Slice Order agree. Preserve historical artifacts and lifecycle authority exactly as required by the current mode.

Open code only to verify a concrete concern. For an initial or pristine replacement draft, split, combine, reorder, or revise slices as needed. For append-only recovery, never renumber, reorder, rewrite, or remove historical slices; revise only the pending extension and append monotonically numbered slices. Verify its `REPLAN_REASON`, supersession mapping, current requirements fingerprint, increasing plan revision, and a current-revision reconciliation/corrective or other explicitly required operational milestone after authority change. Do not add an integration or stabilization Slice merely because several slices exist. If a correction needs a requirements decision or exposes a SPEC boundary problem, return lifecycle `RESUME` instead of masking it with Slices.

When review succeeds, set the mutable global plan and every detailed plan in the initial/replacement set or pending extension to File Purpose Header status `ready` and review state `approved`. Never change a historical detailed plan. Ensure the current revision, extension, and immutable history agree.

## Minimum Reads

- normalized requirements source and referenced requirement records;
- `plan.md` and every detailed plan;
- code only for a named risk or hidden dependency.

## Allowed Effects

- for an initial, planning-only replacement, or wholly pristine materialized replacement, modify, create, remove, or reorder only the candidate planning set needed to leave one coherent approved result;
- for append-only recovery, modify only the pending revision and appended plans while preserving historical planning bytes;
- report exact corrections made.

## Blocks

Block with a lifecycle `RESUME` handoff when approval depends on a missing or conflicting product decision. Return `NEEDS_REPLAN` without writes when no valid initial or pending recovery draft exists, the fingerprint is stale, revision or supersession data is invalid, or history changed. Do not invent answers, create tasks, commit supersession, or alter historical planning artifacts.

## Output

After successful publication, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after REVIEW_PLAN`. Report approval status, concise corrections, the runtime's normal handoff, and all legal operations in the resulting state. A successful initial review normally hands off to `stnl-task-materializer / OPERATION=MATERIALIZE_TASKS` while repeat `REVIEW_PLAN` and `REPLAN` remain legal where preflight permits them. Stop after `REVIEW_PLAN`.
