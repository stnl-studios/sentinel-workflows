# File Purpose Header

```yaml
purpose: Define gates that protect documentary quality and closure of a SPEC.
status: not_applicable
read_when: Reviewing readiness, resuming a SPEC, or deciding whether CLOSE may proceed.
do_not_read_when: Drafting non-binding initial intent without a readiness claim.
contains: Gate definitions, pass conditions, failure behavior, and review checks.
owner: stnl-spec-lifecycle-manager
update_policy: Change when documentary quality policy changes.
```

# Readiness Gates

Use `pass`, `fail`, `blocked`, or `not_applicable` for a gate verdict.

## Required gates

- `canonical_id_gate`: IDs are valid, stable, in headings and fields, and every reference resolves.
- `workspace_gate`: `feature_spec.md` exists, only meaningful shared categories are materialized, and no auxiliary residue or duplicate authority exists.
- `question_gate`: no open question blocks the stated scope or criterion.
- `spec_quality_gate`: objective, context, scope, exclusions when needed, requirements, rules, and contracts have adequate signal.
- `reference_integrity_gate`: references are explicit, valid, and semantically consistent across artifacts.
- `scope_gate`: included and excluded behavior are clear enough to prevent accidental scope expansion.
- `acceptance_criteria_gate`: each applicable criterion is observable, testable by a consumer, and consistent with scope and rules.
- `decision_consistency_gate`: decisions, constraints, risks, and resolved questions do not contradict the SPEC or one another.
- `closure_gate`: durable content can be consolidated without unresolved documentary blocker, duplication, or information loss.

`PLANNING` reports failures as actionable findings and returns `needs_resume`; it does not repair them. `CLOSE` blocks until all applicable gates pass.
