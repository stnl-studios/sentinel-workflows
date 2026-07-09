# File Purpose Header

```yaml
purpose: Template for detailed planning of one conservative delivery phase.
status: ready
read_when: Preparing, delivering, validating, or revising this phase.
do_not_read_when: A different independent phase is the active scope.
contains: Source reference, delivery, scope, dependencies, risks, strategy, expected checks, and ready criterion.
owner: stnl-spec-execution-manager
update_policy: Initial planning creates; revise an unconcluded phase only with an explicit recorded reason.
```

# Phase 01 - <Name>

## Source and Phase Metadata

```yaml
phase: 01
requirements_source: <relative requirements path>
plan_index: plan.md
parallelizable: false
parallel_safety: not_applicable
```

## Objective

<One observable outcome.>

## Observable Result

<What can be observed or tested after this phase.>

## Requirements References

AC-001, D-001, C-001, R-001

## Scope

- <Included work.>

## Out of Scope

- <Excluded work.>

## Likely Areas

- <Path, module, contract, or subsystem.>

Likely areas guide discovery; they are not an absolute allowlist. Record and assess a discovered expansion before acting on a material divergence.

## Dependencies and Risks

- Dependencies: <phase number, external dependency, or none.>
- Risks: R-001

## Strategy

<Concise approach. Record a discovered divergence before acting on it.>

## Expected Tests or Validation

<Observable checks.>

## Ready Criterion

<Conditions needed before detailed tasks can begin.>
