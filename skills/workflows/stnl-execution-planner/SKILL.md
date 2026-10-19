---
name: stnl-execution-planner
description: Author a complete serial Plan and operational Tasks together using current EC-1 Initial preparation or the bounded Q18/Q19 set replacement.
---

# stnl-execution-planner

## Purpose

Run PLAN for an absent official execution, or the bounded current REPLAN described below. One author produces plan.md, every active plans/slice-NN.md, tasks.md and every active tasks/slice-NN.md together. Do not implement or approve your preparation. Use the local templates and references/workspace.md. Requirements authority: sha256:<64hex> and Plan revision: <positive integer> bind the existing canonical requirements fingerprint and normative revision. Runtime delivery IDs do not establish acceptance.

## Inputs

SPEC_PATH is required. REPLAN_REASON is required for REPLAN.

## Authority

Normalize SPEC_PATH with runtime/validate-execution-state.mjs. Before content reads run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> <OPERATION>`. REPLAN requires REPLAN_REASON. An active or uncertain attempt blocks replacement. Legacy incompatible preparations are diagnosed and preserved; no migration or dual executable format is permitted.

## PLAN

Prepare an isolated candidate using `node "<SKILL_ROOT>/runtime/prepare-task-candidate.mjs" --spec-path <SPEC_PATH> --operation <OPERATION>`. Keep its ownership marker. Render both Plan and Tasks from UTF-8 template content as new writable files; do not copy frozen template modes. Fill semantic fields before serialization. Preserve rejected candidates and live bytes; corrections require another complete candidate against unchanged live authority.

Plan carries objective, strategy, exact requirement IDs, serial dependencies, observable results, scope, exclusions and protected responsibilities. Tasks carry a useful Result, Acceptance Obligations with stable local IDs, an initial Checklist associated with those obligations, Expected Tests and the existing evidence/findings/attempt sections. Each obligation names the real requirement, complete or partial contribution, integral verification owner, observable condition and proof required. Never invent a requirement ID or claim full acceptance for partial work. Every condition has an integral owner and proof capable of observing it. A later integration slice cannot silently supply missing evidence for an earlier full acceptance.

Authorized Areas explicitly label `directory:` or `file:`. They define the permissible effects, not an exhaustive list of filenames. Expected Files are operational predictions and may be future files. Existing Inputs must be present regular files when required. Changed/tested files are real files or explicitly proved removals; directories cannot stand in for hashes. Before serialization, all typed claims use their logical artifact location. Persist artifact-relative paths only, with one physical basis, containment and symlink guards. Auth, persistence and public-contract responsibilities are normative; path membership alone does not authorize their alteration.

Declare the normative Verification Recipe identically in detailed Plan and Task using [the recipe contract](references/verification-recipe.md). Select executable, execution base, typed file arguments and reviewed indirect dependencies explicitly. External references must bind Existing Inputs; product references require Authorized Areas. Run the existing serializers before review. Inputs provide read/capture coverage and never authorize writing. The reviewed recipe reaches the runner and its receipt.

Expected Tests and obligation proofs remain explanatory prose and do not define the mechanical domain. Do not infer inputs from punctuation, quotes, filenames or filesystem homonyms. The official producer records each newly created preparation under the U1 lock in the per-execution registry outside the candidate before returning it. Keep its marker; never edit the registry or adopt an unrelated root. Genuine stale candidates remain classified, but stale source/CAS blocks their use.

Run `node "<SKILL_ROOT>/runtime/prepare-plan-candidate.mjs" --candidate-execution-root <CANDIDATE_EXECUTION_ROOT>` then `node "<SKILL_ROOT>/runtime/serialize-plan-paths.mjs" --spec-path <SPEC_PATH> --candidate-execution-root <CANDIDATE_EXECUTION_ROOT>`. These shared producers prepare both sets, bind delivery IDs and validate the complete candidate. No MATERIALIZE_TASKS or REVIEW_TASKS operation exists. The absorbed producers are mechanical resources, not another cognitive phase.

Keep the complete draft isolated. `publish-task-candidate.mjs --spec-path SPEC_PATH --candidate-execution-root CANDIDATE_EXECUTION_ROOT` without a review returns AWAITING_REVIEW and never installs the candidate. Hand that exact owned root to independent REVIEW_PLAN. The current producer does not import or migrate incompatible preparations.

## Output

Report the exact isolated candidate root, source activation when present, current requirements authority, artifact paths, returned review request and AWAITING_REVIEW. PLAN and supported REPLAN hand the complete joint set to independent REVIEW_PLAN. No implementation, formal validation or self-approval.

## REPLAN

The current producer supports only two set replacements under the same requirements authority. The source must be quiet, with every member inspected current/PASS and no normal handoff. Q18 moves all active contributions to completed. Q19 starts with an empty active queue, keeps at least one contribution completed and reopens exactly one completed contribution without pending normalization for a private normative change. A consumer of the reopened contribution or a transverse change blocks this path. Other replacements remain unsupported; preserve the source and report the runtime diagnostic.

After preflight, allocate with `node "<SKILL_ROOT>/runtime/prepare-task-candidate.mjs" --spec-path <SPEC_PATH> --operation REPLAN --completed-delivery-ids '<JSON_ARRAY_OF_COMPLETED_UUIDS>'`. Supply the exact source UUIDs that will remain completed. The official allocation captures the source activation, physical tree and preparation revision under the common lock; a pending registered REPLAN blocks another allocation. Keep the returned root and marker. Never edit the registry, adopt another root or use Initial to replace execution.

Author the current global Plan/Tasks and each reopened detailed pair from the current normative leaves and local templates. Do not restore deleted detailed artifacts from an old preparation. Preserve global objective/strategy/risks, requirement IDs, dependencies and integral owner identities. Q19 permits only a private change in Existing Inputs, Risks and Strategy, Expected Tests or Verification Recipe, subject to the existing shared-input/output guards. Operational checklists and Expected Files cannot expand that authority. Use the same prepare-plan-candidate and serialize-plan-paths commands as PLAN. The producer derives source UUIDs, preparation revision +1 and the reopened local revision +1; it preserves completed local revisions, counters, baselines and slice high-water.

Propose without a review first and pass the exact returned review request to the independent reviewer. Retained records and objects remain literal. Canonical owner representation can change current indices/envelopes for more than the reopened member; review the resulting evidence hashes without inventing independence or changing the owner UUID. Q18 requires exact retain-current decisions; Q19 retains completed contributions and requires revalidate for the reopened contribution. Its old PASS remains historical until another legal VALIDATE_SLICE, with no reset or new validation performed by REPLAN.

Publication uses the exact independently reviewed candidate and existing CAS/product/requirements guards. On an interrupted replacement, preserve the returned publisher allocation and use `node "<SKILL_ROOT>/runtime/publish-task-candidate.mjs" --spec-path <SPEC_PATH> --recover-allocation <PUBLISHER_MARKER>` for official recovery. Confirm publication and own cleanup separately; do not replay publication, take over an uncertain lock or delete foreign controls. Recovery does not run an agent or recipe. Read back the legal handoff; neither an empty active queue nor retained local PASS grants COMPLETE or terminal acceptance.

## Minimum Reads

Current requirements and exact declared IDs, relevant current proof, all four templates, and code only for decisive decomposition premises.

## Allowed Effects

Complete isolated Plan+Tasks candidate; publication occurs only after independent exact-byte review through the current producer. An empty Task alone never proves pristine: inspect known owners, operations and actual captured product first.

## Blocks

Missing decision, stale requirements/base, incompatible legacy, ambiguous carriers, lost history, ownership conflict or unsafe path.
