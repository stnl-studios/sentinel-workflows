# File Purpose Header

```yaml
purpose: Define local and global documentary readiness evidence, structural gates, and semantic judgment boundaries.
status: not_applicable
read_when: INIT may declare ready, RESUME changes status, READINESS evaluates a focus or the whole SPEC, or CLOSE is requested.
do_not_read_when: Drafting initial intent without a readiness or closure claim.
contains: Readiness scopes, evidence strength, structural gates, semantic review, coverage, and verdicts.
owner: stnl-spec-lifecycle-manager
update_policy: Change when documentary quality or closure policy changes.
```

# Readiness Gates

Use `pass`, `fail`, `blocked`, or `not_applicable` for a gate verdict.

## Scope and evidence

`READINESS_SCOPE=LOCAL` evaluates only the named `READINESS_FOCUS`. Read the focus plus the dependencies required for that local conclusion. Return `LOCAL_PASS` or `LOCAL_FINDINGS` and always `global_readiness: NOT_EVALUATED`; never claim global `READY`, change status, or silently repair a finding.

`READINESS_SCOPE=GLOBAL` reads the complete feature and every materialized canonical record. Indexes locate authority but cannot serve as evidence. Return `READY` only when every applicable gate passes; otherwise return `BLOCKED` with actionable findings and exact IDs or paths. The smallest sufficient evidence set grows with the strength of the conclusion: economy never permits omitting a potentially relevant material category.

INIT or RESUME may set the persisted feature status to `ready` only through the global evidence standard. READINESS itself never changes it. CLOSE reruns global gates before closure.

## Required gates

- `document_gate`: File Purpose Header, canonical H1, allowed sections, exact order and uniqueness, and absence of arbitrary preamble or embedded duplicate canonical records satisfy `spec-schema.md`.
- `workspace_gate`: every and only materialized category is indexed; every indexed file exists and has semantic records; derived requirement and blocking-question lists equal canonical state; no lifecycle residue or empty category exists.
- `canonical_identity_gate`: record headings, types, metadata order, category statuses, and ID allocation satisfy `canonical-ids.md` and `spec-schema.md`; existing identities have not been renumbered, reused, gap-filled, or type-swapped.
- `reference_integrity_gate`: the validator computes no broken canonical target, duplicate array entry, improper self-reference, or incompatible prefix. Broken references are diagnostics, never persisted state.
- `relationship_gate`: question/criterion blocker links are bidirectionally exact, decision links resolve, and all other structural relations use their declared origin and destination.
- `question_gate`: no open `blocking` question, active `blocked_by`, or persisted open `irrelevant` question exists. An open `non_blocking` question is allowed only when its classification remains semantically justified.
- `coverage_gate`: every `in_scope` requirement has at least one active AC whose `verifies` names it, or a formal non-placeholder `coverage_justification`; every active AC verifies at least one existing `in_scope` requirement. Traceability exists only from AC to requirement.
- `spec_quality_gate`: objective, facts, hypotheses, scope, exclusions, requirements, business rules, and contracts provide coherent non-placeholder signal; documentary gaps are explicit and none remains for `READY`.
- `acceptance_quality_gate`: active ACs are concrete, observable, verifiable, consistent with covered requirements, scope, and rules, and include applicable negative and failure behavior.
- `consistency_gate`: requirements, decisions, constraints, risks, questions, contracts, and feature prose do not materially contradict one another.

An active mitigated risk remains `active` and does not fail readiness merely by existing. A category or gate is `not_applicable` only when the feature evidence explains why it does not apply; do not materialize an empty file to represent absence.

## Applicable semantic review

For global readiness, judge as applicable: objective/scope coherence, behavioral requirements, critical business rules, observable ACs, negative scenarios, failure paths, constraints, contracts, dependencies, risks, open questions, contradictory decisions, and cross-cutting coverage. A structurally valid SPEC can still be semantically blocked.

Scripts prove explicit grammar, allowed states, references, inverse relations, coverage links, indexes, and transition preservation. The model judges sufficiency, clarity, semantic coherence, contradictions, observability, and whether a classification or justification is credible. Never present a parser or keyword heuristic as proof of semantic quality.
