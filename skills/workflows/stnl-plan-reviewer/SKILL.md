---
name: stnl-plan-reviewer
description: Independently review the complete final Plan and Tasks, including initial checklist and proof capability, and activate only that examined content.
---

# stnl-plan-reviewer

## Purpose

Run only REVIEW_PLAN in an independent context. Read current requirements, the global Plan/Tasks and every detailed Plan/Task, initial checklist and decisive technical premises. Review the complete content that will be activated; a hash binds content but does not prove independence, semantic completeness or acceptance.

## Inputs

SPEC_PATH and the exact CANDIDATE_EXECUTION_ROOT returned by PLAN are required; optional concrete concerns cannot change requirements.

## Authority

Before content reads, use `runtime/prepare-task-candidate.mjs --spec-path SPEC_PATH --operation REVIEW_PLAN --candidate-execution-root CANDIDATE_EXECUTION_ROOT` to validate the existing isolated candidate and its creation association. No official execution may exist. Never create a substitute review root or use Initial to replace execution. Candidate rejection preserves it and live bytes. Correct only editorial, referential or unequivocal defects; a material strategy, decomposition or proof change returns to the author. Physical replacement/REPLAN is unavailable and reports REPLAN_REQUIRED. Both skills carry the same current producer closure in their own installed runtime; never search another installation.


## REVIEW_PLAN

Check each exact requirement ID and observable condition, complete/partial contributions and integral owners, serial dependencies, result coherence, authorization/exclusions, auth/persistence/public contracts, hidden work, initial checklist associations and proof capability. A structurally valid test that observes a different property is insufficient. Name affected verification and premises explicitly. Missing/ambiguous origin or material undecided scope blocks review; operational history never grants normative acceptance. Read code only to settle named decisive premises. A missing product decision returns lifecycle RESUME; stale authority or material strategy gaps require REPLAN.

Review the mandatory Verification Recipe in both Plan and Task using the sibling planner’s references/verification-recipe.md. Check identical executable/typed args/base, product authorization, Existing Inputs for external proof/configuration files, and explicit completeness of imports and indirect dependencies. The runtime verifies the declared references; semantic prose never selects files. Missing/unlinked references block approval. Existing Inputs never grants write scope.

Review dependency completeness explicitly without promising universal discovery. Runtime/version/property prose and homonyms remain explanation even when same-named files exist. Preparation ownership requires the durable creation association from the independently resolved official execution, plus physical identity; a marker or witness alone is not authority. Preserve the source/CAS and the per-execution registry.

Set the final candidate metadata to ready and mutable Plan Review state to approved. Preserve immutable historical content. Run the sibling planner's prepare-plan-candidate.mjs and serialize-plan-paths.mjs recipes from its skill. The single canonicalizer rejects unknown carriers, duplicate fields, hidden headings and ambiguous content. All normative objective/strategy/obligation/proof/dependency/area/responsibility changes require new authorship/review. Operational steps and predicted files do not expand authority.

After final ready/approved metadata and mechanical serialization, run `serialize-plan-paths.mjs --spec-path SPEC_PATH --candidate-execution-root CANDIDATE_EXECUTION_ROOT` for the exact current authority. Save a temporary review JSON with exactly `globalReview` and `deliveries`. Each review has `scope` (`set` or `slice`), `decision: "approved"`, the exact corresponding `authoritySha256`, sorted `examinedArtifactHashes` with every path/SHA-256 in that scope, `evidenceDecisions: []`, and a concrete independent `summary`. Global scope examines plan.md/tasks.md; each delivery entry has its exact deliveryId and a review examining its detailed Plan/Task. Use the returned globalReviewAuthoritySha256, delivery authority and artifactHashes literally; the hashes bind your independent review of those bytes and do not replace that review. Pass the file to `publish-task-candidate.mjs --spec-path SPEC_PATH --candidate-execution-root CANDIDATE_EXECUTION_ROOT --review-decision-file REVIEW_JSON`. Former reviewDecision shapes are unsupported.


The existing Initial producer captures stnl-preparation-v3 from the exact final bytes, validates Plan and Tasks together, locks outside the official trees, rechecks requirements/base, installs the artifacts, writes activation.json last and verifies readback. The reviewed source remains positively owned diagnostic material; its disposal is not implemented by this wrapper. Do not replay publication to clean it up. Only confirmed activation releases execution. Cleanup/release failure after confirmation is pending cleanup, never rollback or another implementation/delegation. Uncertain publication preserves copies and ownership for diagnosis.

## Output

Read back with `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after REVIEW_PLAN`. Report the decision, exact corrections, snapshot/publication status and runtime legal handoff to EXECUTE_SLICE. Preparation approval is not PASS. Stop.

## Minimum Reads

Current requirements, every final Plan and Task, initial checklist, proof capability and decisive technical premises.

## Allowed Effects

Limited unequivocal corrections in an isolated complete candidate; semantic review decision and common publication of the examined bytes.

## Blocks

Missing product decision, stale authority/base, materially different strategy/proof, incompatible legacy, invalid history or active/uncertain attempt.

A command reporting a sandbox or permission denial blocks review even if its exit is zero. Preserve the diagnostic and do not retry via another path, tool, temp setting or permission mode.
