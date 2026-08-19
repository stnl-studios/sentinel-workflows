---
name: stnl-task-materializer
description: Atomically create initial tasks or commit an approved pristine replacement or append-only recovery extension.
---

# stnl-task-materializer

## Purpose

Run only `MATERIALIZE_TASKS`. Convert an approved initial plan or recovery revision into deterministic task artifacts without reinterpreting strategy or exploring implementation by default.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may narrow formatting but cannot change the approved plan.

## Authority

The current approved `plan.md` and approved detailed plans are the only materialization authority. Their `Requirements authority` fingerprint and `Plan revision` must match current authority and the corresponding task references. Requirements clarify referenced acceptance only. This skill may create an initial task set, including from a reviewed planning-only replacement, atomically replace a wholly pristine canonical materialized plan/task set, or append one approved recovery extension. It may not alter requirements or code.

## MATERIALIZE_TASKS

Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> MATERIALIZE_TASKS`. Require a complete approved current revision, matching fingerprints and revision fields, consistent slice sets/order/dependencies/scope/references, and a deterministic materialization mode.

For initial materialization, require no task artifact and create the full set once. A reviewed planning-only replacement is still initial materialization: it remains revision `1` and has no historical recovery fields. For pristine replacement, require the entire existing task set to be exactly `MATERIALIZED_PRISTINE`; stage and atomically replace only canonical plans and tasks with the approved replacement. For append-only recovery, preserve all historical artifacts byte-for-byte except the exact authorized supersession and divergence-disposition fields, append only newly approved monotonically numbered task files and rows, and commit the approved supersession mapping in the same atomic publication. That mapping alone may terminalize each named open prior slice by changing its global row to `[x]`, Validation and Result to `SUPERSEDED`, and its detailed Final Result to `SUPERSEDED` with `Superseded by: slice-NN`. When requirements authority changed, every non-terminal older-fingerprint slice must be so superseded and replaced. Prior `PASS` slices remain `PASS` and are covered by a new current-revision reconciliation/corrective slice.

The same append-only commit is the only owner allowed to change an applicable active divergence to `resolved` or `superseded`. Use local `references/execution-record-schema.md`: a resolved divergence gets a non-placeholder `Resolution` naming the committed plan revision and corrective/replacement slice; a superseded divergence points to a new same-kind `divergence-NN`. Lifecycle `RESUME` may correct external documentary authority, but does not change execution records; the approved replan commit performs the deterministic execution reconciliation. Every open slice containing an applicable active blocking divergence must be terminalized as `SUPERSEDED` with a current-revision replacement; never rewrite its old fingerprint/revision and never resume it under new authority. Reject the commit if an applicable active blocking divergence would remain without an explicit recovery owner.

Validate every precondition and render the complete authorized candidate before publishing any artifact. Publish the authorized path set atomically only after every render and cross-reference succeeds. On failure, remove only invocation-owned staging and restore the exact prepublication authorized set so no partial task/revision set remains. Never touch a path outside the authorized candidate.

Create exactly one `[ ]` row per newly active approved slice in `tasks.md`, using only `[ ]` and `[x]`. Create its detailed task from the pristine template and persist exactly `- Requirements authority: sha256:<64hex>` and `- Plan revision: <positive integer>`. Each task must have an observable result, expected area, requirement reference, and coherent operational order. Include the pristine sections defined by the template and use `references/execution-record-schema.md` for later operational records. Keep the global index compact and details local.

## Minimum Reads

- `plan.md` and every approved detailed plan;
- only requirement excerpts needed to make acceptance objective;
- task templates when writing;
- `references/execution-record-schema.md` for pristine sentinels and committed supersession fields.

## Allowed Effects

- create the initial full task set, atomically replace a wholly pristine set, or append only an approved recovery extension and its supersession transitions.

## Blocks

Return `NEEDS_REPLAN` without writing when plans are missing, unapproved, stale, inconsistent, or cannot be converted without a new decision. Return `BLOCKED` without writing on a partial/malformed task set, an attempted pristine replacement after evidence, a non-monotonic extension, or any history mutation. Never repair a plan or delete operational history.

## Output

Report materialization mode, current fingerprint/revision, created task paths, committed supersession mappings, slice count, and any `NEEDS_REPLAN` reason. Stop after `MATERIALIZE_TASKS`.
