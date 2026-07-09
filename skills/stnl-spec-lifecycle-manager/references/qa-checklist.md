# File Purpose Header

```yaml
purpose: Define lifecycle/qa-checklist.md as a Spec Quality Gate, not a test plan.
load_when: Creating or validating spec quality, slice readiness, or planning gates.
do_not_load_when: Implementing tests or reviewing code.
contains: QA checklist boundaries, global checklist rules, slice readiness derivation, and validation hint rules.
owner: stnl-spec-lifecycle-manager
update_policy: Change when the quality bar for specs changes.
```

# QA Checklist

`lifecycle/qa-checklist.md` is the Spec Quality Gate. It defines the minimum acceptable quality for a modular spec workspace before implementation begins.

It is not a QA test plan, not a scenario list, and not test implementation guidance.

## What it must cover

The checklist must derive from:

- acceptance criteria;
- Spec Definition of Done;
- risks;
- anti-drift constraints;
- validation hints;
- traceability;
- slice readiness;
- workspace path integrity.

## What it must not contain

Do not include:

- test cases;
- BDD scenarios;
- Jest, Cypress, Playwright, Postman, or framework instructions;
- mock or fixture details;
- assertion code;
- command-line test steps;
- implementation plans for test agents.

## Global `qa_checklist`

The global checklist should be compact and ID-driven.

Recommended format:

```yaml
qa_checklist:
  spec_quality_gate:
    status: ready | blocked | incomplete
    blockers: [Q-###, R-###, C-###]
    checks:
      canonical_ids: pass | fail
      workspace_paths: pass | fail
      acceptance_coverage: pass | fail
      open_questions: pass | fail
      anti_drift_constraints: pass | fail
      risk_coverage: pass | fail
      traceability: pass | fail
      slice_readiness: pass | fail
      validation_hints: pass | fail
```

Do not repeat full artifact descriptions in this checklist. Use IDs.

## Slice readiness

Each slice may include compact readiness metadata:

```yaml
slice_readiness:
  status: ready | blocked | needs_reslicing | incomplete
  blockers: [Q-###, R-###]
  missing: [acceptance_criteria, constraints, validation_hints, context_hints]
```

This metadata is not a second spec. Keep it short.

## Spec Definition of Done

A spec is minimally acceptable when:

1. objective is clear;
2. scope and out-of-scope are explicit;
3. no open question remains;
4. acceptance criteria are stable and ID-based;
5. constraints prevent drift;
6. material risks are identified or explicitly absent;
7. every ready slice links to relevant ACs and constraints;
8. every ready slice has validation hints;
9. traceability matrix is compact and ID/path-based;
10. no slice is too small or too large;
11. indexed files exist or absent shared categories are explicitly not materialized;
12. `PLANNING` can return `ready` without needing structural edits.

## Validation hints

`validation_hints` are required for every executable slice.

They should explain what must be observable or verifiable later. They must not explain how to write tests.

Good:

```markdown
- The new state must be visible in the existing status response.
- The operation must preserve the public API contract defined by `D-001`.
- Permission denial must be observable as the existing unauthorized error path.
```

Bad:

```markdown
- Write a Jest test that mocks the service and expects status 200.
- Add Cypress steps to click the submit button.
- Create fixtures for all invalid states.
```

## Token economy rule

The checklist should contain the shortest useful signal. Prefer:

```yaml
acceptance_coverage: pass
linked: [SL-001, AC-001, AC-002]
```

over a paragraph that restates those artifacts.
