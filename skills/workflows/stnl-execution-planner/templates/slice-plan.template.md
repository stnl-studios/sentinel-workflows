# File Purpose Header

```yaml
purpose: Template for one observable and testable serial delivery slice.
status: draft
read_when: PLAN creates or REVIEW_PLAN checks this detailed slice plan.
do_not_read_when: Another slice is active and no concrete dependency requires this plan.
contains: References, objective, observable result, scope, boundaries, dependencies, risks, strategy, expected tests, and completion criterion.
owner: stnl-execution-planner
update_policy: PLAN or REPLAN creates as draft; REVIEW_PLAN corrects only the mutable draft and changes it to ready.
```

# Slice 01 - <Name>

## References

- Slice: 01
- Requirements source: `<relative path>`
- Requirements authority: sha256:<64hex>
- Plan revision: <positive integer>
- Global plan: `../plan.md`
- Review state: pending

## Objective and Observable Result

<One coherent delivery and how it is observed.>

## Requirements

Assigning an AC to this slice commits it to the complete criterion and every observable condition in its authority. Runnable evidence must already exist, or its preparation must belong to this slice's authorized implementation and test paths before independent validation. A later integration slice may broaden coverage but cannot supply missing evidence for an AC assigned here; the independent runner uses prepared checks rather than creating ad hoc scripts.

For a partial contribution, reference the existing requirement ID, describe the bounded partial result, and identify the later dependency-ready slice delivering the complete AC. Each partial contribution still requires checks for its own observable result. Across the serial plan, every AC must have a complete delivery. Use IDs exactly as declared in the authority. Do not invent requirement IDs or claim complete acceptance for a partial contribution.

- AC-001

## Included Scope

- <included work>

## Out of Scope and Boundaries

- <excluded work and boundary with later slices>

## Likely Areas

- Implementation filesystem path (outside generated execution artifacts): `<artifact-relative path>` — <optional contract, subsystem, test area, or explanation> (plain-text description)

## Dependencies

- <earlier slice or none>

## Risks and Strategy

- Risk: <risk and mitigation>
- Strategy: <bounded approach>

## Expected Tests

- <test, command, suite, or observable check>

## Completion Criterion

- <objective result and preserved boundary>
