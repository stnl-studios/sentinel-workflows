---
name: stnl-plan-reviewer
description: Independently review the complete final Plan and Tasks, including initial checklist and proof capability, and activate only that examined content.
---

# stnl-plan-reviewer

## Purpose

Run only REVIEW_PLAN in an independent context. Read current requirements, the global Plan/Tasks and every detailed Plan/Task, initial checklist and decisive technical premises. Review the complete content that will be activated; a hash binds content but does not prove independence, semantic completeness or acceptance.

## Inputs

SPEC_PATH is required; optional concrete concerns cannot change requirements.

## Authority

Before content reads run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> REVIEW_PLAN`. `<PLANNER_SKILL_ROOT>` is the named sibling stnl-execution-planner in this same installed bundle. Never search other installations. Create a complete isolated candidate with its `runtime/prepare-task-candidate.mjs --spec-path <SPEC_PATH> --operation REVIEW_PLAN`. Candidate rejection preserves it and all live bytes. Correct only editorial, referential or unequivocal defects. A material strategy, decomposition or proof change returns to the author; do not approve a substantially different solution you created yourself.

## REVIEW_PLAN

Check each exact requirement ID and observable condition, complete/partial contributions and integral owners, serial dependencies, result coherence, authorization/exclusions, auth/persistence/public contracts, hidden work, initial checklist associations and proof capability. A structurally valid test that observes a different property is insufficient. Review Delivery Continuity against the predecessor: same observable result preserves its UUID/slot even when proof or implementation strategy changes; a genuinely independent result needs a new slot/UUID. Name affected verification and premises explicitly. Missing/ambiguous origin or material undecided scope blocks review; operational history never grants normative acceptance. Read code only to settle named decisive premises. A missing product decision returns lifecycle RESUME; stale authority or material strategy gaps require REPLAN.

Check that pertinent proof and configuration inputs outside captured product areas are present in Existing Inputs in both Plan and Task. Literal proof paths use the command workspace basis; the input carrier uses the artifact-relative basis. An unlinked named file blocks preparation/current PASS. Review indirect inputs explicitly; runtime does not infer them from scripts, imports or command expansion. Existing Inputs grants capture, not write scope.

Set the final candidate metadata to ready and mutable Plan Review state to approved. Preserve immutable historical content. Run the sibling planner's prepare-plan-candidate.mjs and serialize-plan-paths.mjs recipes from its skill. The single canonicalizer rejects unknown carriers, duplicate fields, hidden headings and ambiguous content. All normative objective/strategy/obligation/proof/dependency/area/responsibility changes require new authorship/review. Operational steps and predicted files do not expand authority.

Save the compact independent judgment to a temporary JSON file outside SPEC with exactly: operation=REVIEW_PLAN, status=approved, examined=[requirements, plans, tasks, initial checklist, proof capability], summary=<concrete premises checked and conclusion>. This is a semantic decision, not a cryptographic signature. Pass that file to `node "<PLANNER_SKILL_ROOT>/runtime/publish-task-candidate.mjs" --spec-path <SPEC_PATH> --candidate-execution-root <CANDIDATE_EXECUTION_ROOT> --review-decision-file <REVIEW_DECISION_FILE>`.

The producer captures approved-preparation.json from the exact final bytes, validates Plan and Tasks together, locks outside the official trees, rechecks requirements/base, installs the artifacts, writes activation.json last and verifies readback. No task materializer or optional task review follows. Only confirmed activation releases execution. Cleanup/release failure after confirmation is pending cleanup, never rollback or another implementation/delegation. Uncertain publication preserves copies and ownership for diagnosis.

## Output

Read back with `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after REVIEW_PLAN`. Report the decision, exact corrections, snapshot/publication status and runtime legal handoff to EXECUTE_SLICE. Preparation approval is not PASS. Stop.

## Minimum Reads

Current requirements, every final Plan and Task, initial checklist, proof capability and decisive technical premises.

## Allowed Effects

Limited unequivocal corrections in an isolated complete candidate; semantic review decision and common publication of the examined bytes.

## Blocks

Missing product decision, stale authority/base, materially different strategy/proof, incompatible legacy, invalid history or active/uncertain attempt.
