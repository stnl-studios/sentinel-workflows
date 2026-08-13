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

## REVIEW_PLAN

Before content reads, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> REVIEW_PLAN`. Run only when there is a draft initial plan or pending `REPLAN` revision/extension. It may be repeated while that draft remains mutable. Existing task artifacts do not by themselves block review: in pristine replacement mode, review the full replacement set; after operational evidence, review only the append-only revision and new slices while preserving all historical plan/task artifacts byte-for-byte.

Check full requirement coverage, missing owners, overlap, slice sizing, strict serial order, dependencies, public contracts, persistence, migrations, authentication and authorization, external integrations, shared state, breaking changes, architectural risk, expected tests, implicit work, accidental scope, and consistency between global and detailed plans.

Open code only to verify a concrete concern. For an initial or pristine replacement draft, split, combine, reorder, or revise slices as needed. For append-only recovery, never renumber, reorder, rewrite, or remove historical slices; revise only the pending extension and append monotonically numbered slices. Verify its `REPLAN_REASON`, supersession mapping, current requirements fingerprint, increasing plan revision, and a current-revision reconciliation/corrective slice after authority change. Add an integration or stabilization slice when technically required. If a correction needs a requirements decision, return lifecycle `RESUME` instead of masking it.

When review succeeds, set the mutable global plan and every detailed plan in the initial/replacement set or pending extension to File Purpose Header status `ready` and review state `approved`. Never change a historical detailed plan. Ensure the current revision, extension, and immutable history agree.

## Minimum Reads

- normalized requirements source and referenced requirement records;
- `plan.md` and every detailed plan;
- code only for a named risk or hidden dependency.

## Allowed Effects

- for an initial or wholly pristine replacement, modify, create, remove, or reorder only the candidate planning set needed to leave one coherent approved result;
- for append-only recovery, modify only the pending revision and appended plans while preserving historical planning bytes;
- report exact corrections made.

## Blocks

Block with a lifecycle `RESUME` handoff when approval depends on a missing or conflicting product decision. Return `NEEDS_REPLAN` without writes when no valid initial or pending recovery draft exists, the fingerprint is stale, revision or supersession data is invalid, or history changed. Do not invent answers, create tasks, commit supersession, or alter historical planning artifacts.

## Output

Report approval status and concise corrections. Stop after `REVIEW_PLAN`.
