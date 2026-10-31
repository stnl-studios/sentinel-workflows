# File Purpose Header

```yaml
purpose: Define local and global documentary readiness evidence, structural gates, and semantic judgment boundaries.
status: not_applicable
read_when: Structural validation passed and INIT, RESUME, READINESS, or CLOSE needs a readiness decision.
do_not_read_when: Structural validation failed or initial drafting makes no readiness claim.
contains: Validator-first sequencing, readiness scopes, semantic gates, evidence strength, and verdicts.
owner: stnl-spec-lifecycle-manager
update_policy: Change when documentary quality or closure policy changes.
```

# Readiness Gates

Use pass, fail, blocked or not_applicable per gate.

## Validator-first boundary

Run the structural workspace validator before loading this file. On failure stop semantics: report the diagnostic and only its relevant schema/ID/workspace reference. Return a structural finding, not inferred findings on invalid structure.

On PASS load this file and SPEC evidence. Validator owns grammar, states, indexes, references, inverse relationships and coverage links; do not reread spec-schema.md or canonical-ids.md. Structural validity is not semantic quality.

## Scope and evidence

LOCAL evaluates READINESS_FOCUS and necessary dependencies only: LOCAL_CLEAR or FINDINGS, never global READY, status mutation or broadened review. GLOBAL reads the complete feature and every materialized canonical record; indexes locate but do not prove authority. READY requires every applicable gate to pass; otherwise FINDINGS with evidence and affected SPEC-relative paths. Never omit a potentially material category for economy.

Return exactly runtime/readiness-result.schema.json's fields: version, mode, scope, verdict, workspacePath, snapshotSha256, findings. No global_readiness or per-gate states as response verdicts. Findings have stable F-### IDs, evidence, normalized paths and schema-defined actions; never invent product decisions. Capture readiness snapshots before/after judgment; changed identity blocks a stale verdict.

INIT/RESUME ready claims require global evidence. READINESS neither changes authority/status nor creates attestation by default. Only ready plus semantic GLOBAL/READY and an explicitly legitimate external consumer permits modes.md's external attestation command; LOCAL/nonREADY cannot authorize it. Draft-to-ready uses the normal RESUME publisher's own attestation. Never attest a candidate or hand-write proof. Attestation proves the exact reviewed snapshot, not durable SPEC authority.

CLOSE uses the target-only publisher and its absent/current-integral-COMPLETE, ownership and retirement gates; terminal attestation is not mandatory. An explicitly supplied optional attestation must pass freshness/identity checks: stale/mismatched proof blocks that invocation, not a later legitimate invocation without it.

## Required gates

- document_gate: validator confirms File Purpose Header, canonical H1, allowed sections/order/uniqueness, no duplicate authority.
- workspace_gate: exact materialized indexes, real records/derived lists; no lifecycle residue or empty categories.
- canonical_identity_gate: validator/transition confirm headings, types, ordered metadata, statuses, allocation and preserved identity.
- reference_integrity_gate: no computed broken target, duplicate array entry, improper self-reference or incompatible prefix. Never persist diagnostics as state.
- relationship_gate: bidirectionally exact question/criterion blockers, resolved decision links and declared relation origins/destinations.
- question_gate: no open blocking question, active blocked_by or open irrelevant question. Open non-blocking questions require semantically valid classification.
- coverage_gate: each in-scope R has active verifying AC or credible formal coverage_justification; each active AC verifies an existing in-scope R. Traceability is AC to R only.
- spec_quality_gate: coherent, non-placeholder objective, facts, hypotheses, scope/exclusions, requirements, rules and contracts; no relevant documentary gap.
- acceptance_quality_gate: active ACs are concrete, observable, verifiable and consistent with requirements/scope/rules, including applicable negatives/failures. Examples alone bind no literals; material compatibility choices need authority or clarification.
- consistency_gate: no material contradiction among requirements, decisions, constraints, risks, questions, contracts and feature prose.

Active mitigated risk alone does not fail readiness. not_applicable requires evidence explaining the category/gate; never create empty files for absence.

## Semantic review boundary

Global judgment covers objective/scope, behavioral requirements, critical rules, observable ACs, negatives/failure paths, constraints, contracts, dependencies, risks, questions, contradictory decisions and cross-cutting coverage. The model owns sufficiency, clarity, coherence, observability and credible classifications/justifications. Parser, keyword heuristic or persisted index is never semantic proof.
