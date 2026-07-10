# File Purpose Header

```yaml
purpose: Define deterministic gates for documentary readiness and safe closure.
status: not_applicable
read_when: INIT may declare ready, RESUME changes status, PLANNING reviews, or CLOSE is requested.
do_not_read_when: Drafting initial intent without a readiness or closure claim.
contains: Structural, state, quality, relationship, preservation, and external-boundary gates.
owner: stnl-spec-lifecycle-manager
update_policy: Change when documentary quality or closure policy changes.
```

# Readiness Gates

Use `pass`, `fail`, `blocked`, or `not_applicable` for a gate verdict.

## Required gates

- `canonical_id_gate`: headings are canonical and unique; the heading is the only ID authority; prefixes match files; metadata fields, order, arrays, statuses, impacts, and narrative sections satisfy the category schema; items contain no YAML, duplicate `id:`, or optional `null`.
- `workspace_gate`: `feature_spec.md` exists; every and only materialized category is indexed; indexed files exist, contain semantic items, and no duplicate authority or lifecycle residue exists; external directories are outside this gate.
- `question_gate`: no question is `open`; feature and questions headers reflect open state; `open_questions` exactly matches the sorted open IDs.
- `spec_quality_gate`: objective, facts, hypotheses, scope, exclusions, requirements, rules, and contracts contain adequate non-placeholder signal; every documentary gap is explicit.
- `reference_integrity_gate`: every structural target exists with a compatible prefix; arrays have no duplicates or improper self-reference; narrative external references are ignored by internal-ID validation.
- `relationship_gate`: `blocks` and `blocked_by` are bidirectionally exact; `linked_decision` resolves to a decision.
- `scope_gate`: included and excluded behavior prevent accidental expansion.
- `acceptance_criteria_gate`: active criteria are sufficiently concrete, observable, verifiable, and consistent with scope and rules.
- `decision_consistency_gate`: decisions, constraints, risks, and final questions do not materially conflict with the SPEC or one another.
- `closure_gate`: no open question, broken reference, material conflict, or blocking gap remains; durable content can be consolidated without structural or narrative loss.
- `external_boundary_gate`: CLOSE leaves `execution/` and every other non-lifecycle directory unchanged and does not use implementation evidence as a documentary prerequisite.

Any open question forces the feature header to `blocked`, even when `blocks: []`. A `ready` SPEC has no open question, broken reference, or documentary gap. An active mitigated risk remains `active` and does not fail readiness merely by existing.

`PLANNING` reports failures as `NEEDS_RESUME` findings and never repairs them. `CLOSE` blocks until every applicable gate passes.
