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

Apply review corrections only to an isolated complete execution candidate. The deterministic `runtime/serialize-plan-paths.mjs` boundary canonicalizes plan paths and invokes the existing official `validateExecutionCandidate` authority with the same `<SPEC_PATH>` and candidate root before it can report PASS. Do not separately assemble the validator command. Candidate rejection preserves live bytes; never repair or re-present a rejected candidate. After strict candidate PASS, publish only authorized planning paths and use the final handoff command as strict readback.

Before path serialization and candidate validation, run the deterministic `runtime/prepare-plan-candidate.mjs` producer against the isolated candidate execution root. It reads the canonical plan and slice-plan templates and prepends the exact header when no marker exists. For a present header, it requires one complete block with exactly the template field set and one valid `status: draft|ready`; it canonicalizes fixed metadata values and field order from the template while preserving that status. Missing, duplicate, or unknown fields; missing or invalid status; and malformed, misplaced, or duplicate markers block before candidate validation. This is prevalidation mechanical serialization, never repair after rejection, and never edits live execution artifacts.

For global `Expected areas` and detailed `Likely Areas`, treat only Markdown code spans as concrete filesystem claims. In the mutable candidate before serialization, global code spans are repository-root-relative semantic physical targets; the producer writes the final artifact-relative claims into the global and detailed artifacts. After serialization, verify every persisted claim against its containing artifact and keep conceptual labels outside code spans. Malformed or ambiguous semantic input blocks before publication; never repair a rejected candidate.

After `runtime/serialize-plan-paths.mjs` has serialized the candidate, recompute every reviewed plan claim from its declaring artifact with `path.relative(path.dirname(artifact), physicalTarget)`, normalize `/`, compare by `realpath` with the physical target, and return `BLOCKED` without publication if any claim differs; never approve a plan claim that resolves to another path. The raw global `Expected areas` selections are semantic repository-relative inputs, not yet persisted artifact-relative claims, so never apply this artifact-relative readback to the raw semantic input before serialization.

The candidate global plan `Expected areas` code spans are the reviewed semantic physical-target selections. Run the deterministic `runtime/serialize-plan-paths.mjs` producer boundary against the exact `SPEC_PATH` and isolated candidate execution root. It resolves each selected repository-relative target once, writes canonical global and detailed-plan claims, then invokes the official candidate validator with those same inputs. A non-zero serialization or candidate-validation result is `BLOCKED` without publication; never wait for rejection and then alter or re-present a candidate, guess a target, or edit live artifacts.

Check full requirement coverage, missing owners, overlap, slice sizing, strict serial order, dependencies, public contracts, persistence, migrations, authentication and authorization, external integrations, shared state, breaking changes, architectural risk, expected tests, implicit work, accidental scope, and consistency between global and detailed plans.

Open code only to verify a concrete concern. For an initial or pristine replacement draft, split, combine, reorder, or revise slices as needed. For append-only recovery, never renumber, reorder, rewrite, or remove historical slices; revise only the pending extension and append monotonically numbered slices. Verify its `REPLAN_REASON`, supersession mapping, current requirements fingerprint, increasing plan revision, and a current-revision reconciliation/corrective slice after authority change. Add an integration or stabilization slice when technically required. If a correction needs a requirements decision, return lifecycle `RESUME` instead of masking it.

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
