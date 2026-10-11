---
name: stnl-execution-planner
description: Author a complete serial Plan and operational Tasks together from current requirements, or explicitly REPLAN that same delivery.
---

# stnl-execution-planner

## Purpose

Run exactly one operation, PLAN or REPLAN. One author produces plan.md, every plans/slice-NN.md, tasks.md and every tasks/slice-NN.md together. Do not implement or approve your preparation. Use the local templates and references/workspace.md. Requirements authority: sha256:<64hex> and Plan revision: <positive integer> bind the existing canonical requirements fingerprint and normative revision. Runtime delivery IDs do not establish acceptance.

## Inputs

SPEC_PATH is required. REPLAN_REASON is required for REPLAN.

## Authority

Normalize SPEC_PATH with runtime/validate-execution-state.mjs. Before content reads run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> <OPERATION>`. REPLAN requires REPLAN_REASON. An active or uncertain attempt blocks replacement. Legacy incompatible preparations are diagnosed and preserved; no migration or dual executable format is permitted.

## PLAN

Prepare an isolated candidate using `node "<SKILL_ROOT>/runtime/prepare-task-candidate.mjs" --spec-path <SPEC_PATH> --operation <OPERATION>`. Keep its ownership marker. Render both Plan and Tasks from UTF-8 template content as new writable files; do not copy frozen template modes. Fill semantic fields before serialization. Preserve rejected candidates and live bytes; corrections require another complete candidate against unchanged live authority.

Plan carries objective, strategy, exact requirement IDs, serial dependencies, observable results, scope, exclusions and protected responsibilities. Tasks carry a useful Result, Acceptance Obligations with stable local IDs, an initial Checklist associated with those obligations, Expected Tests and the existing evidence/findings/attempt sections. Each obligation names the real requirement, complete or partial contribution, integral verification owner, observable condition and proof required. Never invent a requirement ID or claim full acceptance for partial work. Every condition has an integral owner and proof capable of observing it. A later integration slice cannot silently supply missing evidence for an earlier full acceptance.

Authorized Areas explicitly label `directory:` or `file:`. They define the permissible effects, not an exhaustive list of filenames. Expected Files are operational predictions and may be future files. Existing Inputs must be present regular files when required. Changed/tested files are real files or explicitly proved removals; directories cannot stand in for hashes. Before serialization, global Authorized areas code spans select repository-relative targets. Persist artifact-relative paths only, with one physical basis, containment and symlink guards. Auth, persistence and public-contract responsibilities are normative; path membership alone does not authorize their alteration.

Bind every pertinent existing proof/configuration input outside the captured product areas through Existing Inputs in both detailed Plan and Task. Literal files named in Expected Tests or obligation proofs use the command workspace basis; Existing Inputs retains the artifact-relative basis. The producer refuses preparation or current PASS when such a named file lacks that binding. Declare indirect inputs explicitly as well: runtime does not resolve scripts, imports, shell expansions or host files. Input capture does not authorize product writes.

Run `node "<SKILL_ROOT>/runtime/prepare-plan-candidate.mjs" --candidate-execution-root <CANDIDATE_EXECUTION_ROOT>` then `node "<SKILL_ROOT>/runtime/serialize-plan-paths.mjs" --spec-path <SPEC_PATH> --candidate-execution-root <CANDIDATE_EXECUTION_ROOT>`. These shared producers prepare both sets, bind delivery IDs and validate the complete candidate. No MATERIALIZE_TASKS or REVIEW_TASKS operation exists. The absorbed producers are mechanical resources, not another cognitive phase.

Publish the complete draft with `node "<SKILL_ROOT>/runtime/publish-task-candidate.mjs" --spec-path <SPEC_PATH> --candidate-execution-root <CANDIDATE_EXECUTION_ROOT>`. It captures/rechecks the base under the common external lock and preserves prior snapshots and evidence. Drafts have no executable activation. Do not write live artifacts outside the publisher. REPLAN preserves historical facts and snapshots. Same-result correction uses `--revision-mode same-delivery-revision`, retains the runtime UUID/slot, and fills the total normative Delivery Continuity table with predecessor UUID/revision, same/new decision, reason and affected verification. An independent result appends a new slot/UUID; never relabel an existing slot. Pristine replacement and append-only supersession retain their existing guards. Runtime seals historical Task/snapshot bytes before compacting the current evidence cycle; historical PASS remains immutable.

## Output

Use `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after <OPERATION>` for readback. Report the runtime's handoff, current authority, changed artifact paths and concrete blocks. PLAN/REPLAN hands off to independent REVIEW_PLAN of the joint set. Stop; no implementation, formal validation or self-approval.

## REPLAN

Use the same combined producer for an explicit recovery revision. Preserve operational history and referenced snapshots. Never replace an active/uncertain attempt.

## Minimum Reads

Current requirements and exact declared IDs, relevant prior history, all four templates, and code only for decisive decomposition premises.

## Allowed Effects

Complete isolated Plan+Tasks candidate and its common publication; Continuity/baseline/history/capture metadata only through producers. An empty Task alone never proves pristine: inspect known owners, operations and actual captured product first.

## Blocks

Missing decision, stale requirements/base, incompatible legacy, ambiguous carriers, lost history, ownership conflict or unsafe path.
