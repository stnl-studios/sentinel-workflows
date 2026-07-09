# File Purpose Header

```yaml
purpose: Template for detailed delivery tasks and evidence of one phase.
status: ready
read_when: Delivering, validating, correcting, or concluding this phase.
do_not_read_when: A different phase is active and has no dependency on this one.
contains: Checklist, acceptance, expected and actual areas, tests, findings, corrections, revalidation, diff summary, and result.
owner: stnl-spec-execution-manager
update_policy: Delivery updates tasks and evidence; conclusion completes only after independent validation passes.
```

# Phase 01 Tasks - <Name>

## Source and Phase Metadata

```yaml
phase: 01
requirements_source: <relative requirements path>
plan: plans/plan-01.md
covered_references: [AC-001, C-001]
```

## Checklist

- [ ] 1.1 <task> — areas: <paths or systems> — acceptance: AC-001
- [ ] 1.2 <task> — areas: <paths or systems> — acceptance: AC-001

## Expected Tests

- <Relevant test or observable check.>

## Execution Evidence

```yaml
actual_changed_areas: []
tests_executed: []
test_result: pending
validation: pending
findings: []
corrections: []
revalidation: pending
diff_summary: null
phase_result: pending
```
