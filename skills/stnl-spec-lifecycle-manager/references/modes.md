# File Purpose Header

```yaml
purpose: Define allowed changes and blocking behavior for the four SPEC lifecycle MODEs.
status: not_applicable
read_when: Selecting or applying INIT, RESUME, PLANNING, or CLOSE.
do_not_read_when: Only a file template or canonical ID format is needed.
contains: Mode responsibilities, transitions, restrictions, and completion conditions.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when lifecycle semantics change.
```

# Lifecycle MODEs

Use exactly one MODE at a time.

## INIT

Create or mature a documentary SPEC from supplied information. Materialize only meaningful shared categories and blocking questions. Separate facts, hypotheses, and decisions. Do not write code or operational planning artifacts.

## RESUME

Apply explicit answers, decisions, corrections, or scope deltas to the affected SPEC artifacts. Preserve valid IDs and relevant decisions, expose the change, and resolve cross-reference inconsistencies. Do not conceal unresolved ambiguity or create operational artifacts.

## PLANNING

Read the existing SPEC selectively and make no changes. Assess documentary readiness using the defined gates. Return `READY` when sufficient, or `NEEDS_RESUME` with actionable findings and affected artifacts or canonical IDs when correction is necessary.

## CLOSE

Consolidate a documentary SPEC only after its gates pass. Incorporate durable content into `feature_spec.md`, then remove `shared/`. Do not depend on code changes, operational history, or a particular delivery method.
