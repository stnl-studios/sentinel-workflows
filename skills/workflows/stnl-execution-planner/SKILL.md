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

Render the complete model-authored planning set in an isolated operating-system temporary candidate. The deterministic `runtime/serialize-plan-paths.mjs` boundary canonicalizes the plan paths and then invokes the existing official `validateExecutionCandidate` authority with the same `<SPEC_PATH>` and `<CANDIDATE_EXECUTION_ROOT>` before it can report PASS. Do not separately assemble the validator command. Candidate rejection preserves all live bytes; never repair or re-present a rejected candidate. Publish only the authorized planning paths after strict candidate validation succeeds, then perform the operation-specific strict readback below.

Before path serialization and candidate validation, run the deterministic `runtime/prepare-plan-candidate.mjs` producer against the isolated candidate execution root. It reads the canonical plan and slice-plan templates and prepends the exact header when no marker exists. For a present header, it requires one complete block with exactly the template field set and one valid `status: draft|ready`; it canonicalizes fixed metadata values and field order from the template while preserving that status. Missing, duplicate, or unknown fields; missing or invalid status; and malformed, misplaced, or duplicate markers block before candidate validation. This is prevalidation mechanical serialization, never repair after rejection, and never edits live execution artifacts.

Execution preflight is read-only. Only when it reports a mechanical violation for the exact `Findings IDs` alias or the exact historical `Check discovery sources` / `Check discovery actions` pair may this skill explicitly run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --repair-known-contract` once and repeat the original preflight; every other contract violation blocks.

## PLAN

Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> PLAN`. Ignore `__MACOSX`, `.DS_Store`, and `._*` when deciding whether a directory is empty. Structural inspection may report lifecycle `draft|blocked + EMPTY`, but PLAN is legal only for lifecycle `ready + EMPTY` or standalone `EMPTY`. An exact official historical lifecycle-root execution signature blocks as legacy before EMPTY classification. If any recognized planning or execution artifact exists, return `BLOCKED`, list it, preserve every byte, and name the operation compatible with the observed state. Unrelated execution-root content is also a collision and blocks. Reset is not a PLAN behavior.

Read `references/workspace.md`, the requirements needed for coverage, shallow project structure, and only code or tests directly needed to understand impact. Define observable, testable slices in strict serial order. Record explicit dependencies, requirement coverage, included and excluded scope, boundaries, risks, likely areas, expected tests, and integration needs. Avoid microtasks and broad slices.

In global `Expected areas` and detailed `Likely Areas`, every Markdown code span is reserved exclusively for one concrete implementation filesystem path and is interpreted deterministically as a path claim. The model's global `Expected areas` code spans are semantic physical-target selections expressed relative to the repository root containing the real `.git` marker; they are not yet persisted artifact-relative claims. The deterministic producer resolves them and writes the canonical artifact-relative claim into the global plan and detailed plans before candidate validation. These carriers are implementation-only: never put `execution/plan.md`, `plans/...`, `tasks/...`, another generated execution artifact, a command, a symbol, or a conceptual label in a code span; keep those concepts in plain text or omit them. Every persisted path is relative to the artifact containing it. Candidate validation rejects non-canonical, escaping, symlinked, execution-root, or accidental lifecycle-SPEC-local implementation targets; malformed or ambiguous semantic input blocks before publication, and a rejected candidate is never repaired.
If the model escapes a closing Markdown fence with one trailing backslash immediately before that fence, `runtime/serialize-plan-paths.mjs` removes only that delimiter escape before semantic target resolution. Interior backslashes remain invalid semantic path input and are rejected.

Resolve every implementation claim from the containing artifact to the nearest ancestor of the normalized requirements source that contains a real `.git` marker. `SPEC_PATH` is not necessarily the project root: when the SPEC is nested under `specs/...`, include every `..` component required to reach the repository implementation target. Never derive the claim from CWD, a temporary candidate/session root, or the parent of `SPEC_PATH` by assumption.

After `runtime/serialize-plan-paths.mjs` has serialized the candidate, recompute every plan claim from its declaring artifact with `path.relative(path.dirname(artifact), physicalTarget)`, normalize `/`, compare by `realpath` with the physical target, and return `BLOCKED` without publication if any claim differs; never publish a plan claim that resolves to another path. The raw global `Expected areas` selections are semantic repository-relative inputs, not yet persisted artifact-relative claims, so never apply this artifact-relative readback to the raw semantic input before serialization.

The global plan `Expected areas` code spans are the model's semantic physical-target selections. Run the deterministic `runtime/serialize-plan-paths.mjs` producer boundary against the exact `SPEC_PATH` and isolated candidate execution root. It resolves each selected repository-relative target once, writes both canonical artifact-relative claims, and then invokes the official candidate validator with those same inputs. A non-zero serializer or candidate-validation result is `BLOCKED` without publication; never wait for rejection and then alter or re-present the candidate, guess a target, or edit live artifacts.

Do not invent a filesystem path to fill either carrier. When only a conceptual area is known, keep it as plain text where the contract permits; when a concrete claim is required but no physical target is supported by observed structure, block planning instead of fabricating a path.

If several slices require real integration verification, add a final explicit integration or stabilization slice. Do not defer that verification to closing.

Create `plan.md` and every foreseeable `plans/slice-NN.md` using the templates. Set each File Purpose Header status to `draft`; this means planning exists but independent review has not approved it.

## REPLAN

Require explicit `REPLAN_REASON`. Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> REPLAN`. Derive the exact one of three mutation classes solely from deterministic execution state: planning exists with tasks absent, tasks exist and are wholly pristine, or operational evidence/history exists. Never accept a caller-selected reset or extension mode. Recompute the current requirements fingerprint before any proposal. If a product decision or documentary change is still required, return a lifecycle `RESUME` handoff without drafting.

When planning artifacts exist but neither `tasks.md` nor `tasks/` exists, they are mutable unmaterialized authority, not historical execution state. Build one complete replacement planning set in isolation and atomically replace exactly `plan.md` plus the detailed plans named by its Serial Slice Order. Remove obsolete canonical detailed plans in the same publication so no competing planning authority survives. Keep Plan revision `1`; omit `Revision mode`, `Replan reason`, and `Supersedes open slices` because those fields describe recovery from materialized history. Publish the replacement as draft/pending review, return to `PLANNED_DRAFT`, and require the normal `REVIEW_PLAN` then initial `MATERIALIZE_TASKS` flow. Do not create an append-only recovery revision merely because planning files existed.

When the complete task set is `MATERIALIZED_PRISTINE`, build one full replacement plan set in isolation. Preserve the source and every unrelated byte while rendering. Use the existing increasing revision with `Revision mode: pristine-replacement`; the later materialization commit may atomically replace only the canonical plans and pristine task set, returning execution to draft planning. This is the only state in which materialized task artifacts may be replaced or removed.

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
- on explicit `REPLAN`, atomically replace planning-only authority, draft a materialized-pristine replacement, or stage an append-only recovery extension as determined by state;
- report coverage and concrete uncertainty.

## Blocks

Block without writes when inputs or execution state are invalid, `PLAN` sees a non-empty root, the requirements fingerprint cannot be computed, requirements are insufficient for deterministic planning, or a product decision is required. Return ambiguity to the requirements owner; do not invent an answer. `REPLAN` must never reset after operational evidence or modify historical artifacts.

## Output

After successful publication, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after <OPERATION>`. Report operation, status (`REPLAN_DRAFT` for successful `REPLAN`), current requirements fingerprint, plan revision, created or proposed paths, supersession mappings, slice order, coverage, material risks, the runtime's normal handoff, and every legal operation in the resulting state. A successful `PLAN` normally hands off to `stnl-plan-reviewer / OPERATION=REVIEW_PLAN`; legal `REPLAN` remains separate. Stop.
