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

Use `pass`, `fail`, `blocked`, or `not_applicable` for each gate.

## Validator-first boundary

First run the structural workspace validator without loading this file. If it fails, stop: report its diagnostic, load only the specific schema, ID, or workspace reference needed to interpret that failure, and return a structural finding. Do not perform semantic review or infer other findings from an invalid structure.

After a green structural result, load this file and SPEC evidence. The validator result is authoritative for explicit grammar, allowed states, indexes, references, inverse relationships, and coverage links, so do not load `spec-schema.md` or `canonical-ids.md` again. It is not evidence of semantic quality.

## Scope and evidence

`READINESS_SCOPE=LOCAL` evaluates only `READINESS_FOCUS` plus dependencies required for that conclusion. Return `LOCAL_CLEAR` when the focus is clear, otherwise `FINDINGS`; never claim global `READY`, change status, or widen into a global review.

`READINESS_SCOPE=GLOBAL` reads the complete feature and every materialized canonical record. Indexes locate authority but are not evidence. Return `READY` only when every applicable gate passes; otherwise return `FINDINGS` with concrete evidence and affected SPEC-relative paths. Economy never permits omitting a potentially relevant material category.

Return one JSON object matching `runtime/readiness-result.schema.json`, with exactly its required fields: version, mode, scope, verdict, workspacePath, snapshotSha256 and findings. Do not add `global_readiness` or return per-gate states as response verdicts. Findings use stable `F-###` IDs, concrete evidence, normalized SPEC-relative paths and the actions defined by that schema; they cannot invent missing product decisions. Capture the normal readiness snapshot before and after semantic evaluation; a changed identity blocks the result rather than granting a verdict on stale bytes.

INIT or RESUME may set `ready` only after the global evidence standard. READINESS never changes workspace status or authority and does not create an attestation by default. After semantic `GLOBAL/READY` for a ready workspace, the deterministic command in `modes.md` may create an external attestation for an explicitly legitimate consumer. LOCAL and every non-READY verdict cannot authorize that creation. Draft-to-ready status-only promotion instead uses the normal RESUME publisher's own attestation as described in `modes.md`; never create an attestation on a candidate or hand-write it. An attestation is operational proof of the exact reviewed snapshot, not durable SPEC authority.

CLOSE does not require a terminal readiness attestation. Use the target-only normal publisher; it derives whether execution is absent or current integral COMPLETE and applies its ownership/retirement gates. If an optional attestation is explicitly supplied, it must pass the normal freshness and identity checks; a stale or mismatched supplied attestation blocks that invocation, without making an attestation mandatory for a later legitimate CLOSE.

## Required gates

- `document_gate`: the validator confirms the File Purpose Header, canonical H1, allowed sections, order, uniqueness, and absence of duplicate authority.
- `workspace_gate`: the validator confirms exact materialized indexes, real records, derived lists, and absence of lifecycle residue or empty categories.
- `canonical_identity_gate`: the validator and applicable transition confirm headings, types, ordered metadata, statuses, allocation, and preserved identities.
- `reference_integrity_gate`: no computed broken target, duplicate array entry, improper self-reference, or incompatible prefix exists. Diagnostics are never persisted state.
- `relationship_gate`: question/criterion blockers are bidirectionally exact, decision links resolve, and structural relations use declared origins and destinations.
- `question_gate`: no open blocking question, active `blocked_by`, or open irrelevant question exists. An open non-blocking question is allowed only when its classification remains semantically justified.
- `coverage_gate`: every in-scope requirement has an active AC that verifies it or a credible formal `coverage_justification`; every active AC verifies an existing in-scope requirement. Traceability is AC to requirement only.
- `spec_quality_gate`: objective, facts, hypotheses, scope, exclusions, requirements, business rules, and contracts provide coherent, non-placeholder signal; no readiness-relevant documentary gap remains.
- `acceptance_quality_gate`: active ACs are concrete, observable, verifiable, consistent with requirements, scope, and rules, and include applicable negative and failure behavior. Examples alone bind no literals; material compatibility choices need authority or clarification.
- `consistency_gate`: requirements, decisions, constraints, risks, questions, contracts, and feature prose have no material contradiction.

An active mitigated risk remains active and does not fail readiness merely by existing. A category or gate is `not_applicable` only when feature evidence explains why; never materialize an empty file to represent absence.

## Semantic review boundary

For global readiness, judge objective/scope coherence, behavioral requirements, critical rules, observable ACs, negative scenarios, failure paths, constraints, contracts, dependencies, risks, questions, contradictory decisions, and cross-cutting coverage. The model owns sufficiency, clarity, coherence, observability, and credible classifications or justifications. Never present a parser, keyword heuristic, or persisted index as semantic proof.
