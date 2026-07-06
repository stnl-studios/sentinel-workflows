---
name: stnl-testing
description: Builds precise, bounded evidence strategies and focused automated or manual checks for an approved Sentinel slice.
---

# Testing

Use when the approved slice or test plan requires test design, implementation, execution, validation, or review.

## Define evidence

- Map every test to an acceptance criterion, relevant DoD item, regression risk, or explicit technical contract.
- Classify it as mandatory, recommended, optional, or manual.
- State command/action, setup, observable result, and failure condition.
- Use the lowest-cost test level that proves the behavior; add higher-level coverage only for a real boundary or integration risk.

## Implement and assess

- Follow existing test framework, fixture, naming, mocking, and data-cleanup patterns.
- Test observable behavior and stable contracts, not private implementation details.
- Keep tests deterministic and isolated. Control time, randomness, network, and external state where the project supports it.
- Include relevant success, failure, boundary, authorization, concurrency, or regression cases without pursuing infinite coverage.
- Never weaken assertions, skip tests, or over-mock the behavior under test merely to obtain a pass.
- Separate pre-existing failures from slice-caused failures with evidence.

## Report

Record exact commands/actions actually run, environment assumptions, concise pass/fail counts or outcomes, and omitted mandatory checks. A build, lint, snapshot, or manual observation proves only what it directly exercises.

## Stop

Return `NEEDS_RETEST_PLAN` when approved evidence cannot prove the criterion, needs unavailable infrastructure, or requires out-of-scope paths. Return `NEEDS_REPLAN` when the implementation boundary itself prevents reliable testing.
