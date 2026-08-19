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

`READINESS_SCOPE=LOCAL` evaluates only `READINESS_FOCUS` plus dependencies required for that conclusion. Return `LOCAL_PASS` or `LOCAL_FINDINGS` and always `global_readiness: NOT_EVALUATED`; never claim global `READY`, change status, or widen into a global review.

`READINESS_SCOPE=GLOBAL` reads the complete feature and every materialized canonical record. Indexes locate authority but are not evidence. Return `READY` only when every applicable gate passes; otherwise return `BLOCKED` with exact IDs or paths. Economy never permits omitting a potentially relevant material category.

INIT or RESUME may set `ready` only after the global evidence standard. READINESS never changes workspace status or authority. After a semantic `GLOBAL/READY` verdict, generate the external readiness attestation with the deterministic command in `modes.md`; `LOCAL` and every non-`READY` verdict must not generate one. The attestation is operational proof of the exact reviewed snapshot, not durable SPEC authority. CLOSE rejects a stale or mismatched attestation and requires a new global review.

## Required gates

- `document_gate`: the validator confirms the File Purpose Header, canonical H1, allowed sections, order, uniqueness, and absence of duplicate authority.
- `workspace_gate`: the validator confirms exact materialized indexes, real records, derived lists, and absence of lifecycle residue or empty categories.
- `canonical_identity_gate`: the validator and applicable transition confirm headings, types, ordered metadata, statuses, allocation, and preserved identities.
- `reference_integrity_gate`: no computed broken target, duplicate array entry, improper self-reference, or incompatible prefix exists. Diagnostics are never persisted state.
- `relationship_gate`: question/criterion blockers are bidirectionally exact, decision links resolve, and structural relations use declared origins and destinations.
- `question_gate`: no open blocking question, active `blocked_by`, or open irrelevant question exists. An open non-blocking question is allowed only when its classification remains semantically justified.
- `coverage_gate`: every in-scope requirement has an active AC that verifies it or a credible formal `coverage_justification`; every active AC verifies an existing in-scope requirement. Traceability is AC to requirement only.
- `spec_quality_gate`: objective, facts, hypotheses, scope, exclusions, requirements, business rules, and contracts provide coherent, non-placeholder signal; no readiness-relevant documentary gap remains.
- `acceptance_quality_gate`: active ACs are concrete, observable, verifiable, consistent with requirements, scope, and rules, and include applicable negative and failure behavior.
- `consistency_gate`: requirements, decisions, constraints, risks, questions, contracts, and feature prose have no material contradiction.

An active mitigated risk remains active and does not fail readiness merely by existing. A category or gate is `not_applicable` only when feature evidence explains why; never materialize an empty file to represent absence.

## Semantic review boundary

For global readiness, judge objective/scope coherence, behavioral requirements, critical rules, observable ACs, negative scenarios, failure paths, constraints, contracts, dependencies, risks, questions, contradictory decisions, and cross-cutting coverage. The model owns sufficiency, clarity, coherence, observability, and credible classifications or justifications. Never present a parser, keyword heuristic, or persisted index as semantic proof.
