---
name: stnl-testing
description: Builds precise, bounded evidence for an approved Sentinel slice and reviews whether tests prove behavior without excessive cost or implementation coupling.
---

# Testing

Use when the approved slice or validation plan requires test design, implementation, execution, review, or evidence assessment. Testing should prove the changed contract at the lowest sufficient cost, not maximize test count.

## Define evidence

- Map each meaningful check to an acceptance criterion, DoD item, regression risk, bug reproduction, or explicit technical contract.
- Choose the lowest-cost level that can prove the behavior: focused unit/state test first when appropriate, then component/integration/contract/end-to-end only for boundaries those lower levels cannot prove.
- Define setup, action/command, observable result, and failure condition. Classify mandatory evidence when the approved plan does so.
- Include success plus relevant failure/boundary behavior; do not generate a combinatorial matrix without a concrete risk.

## Implement and assess

- Follow existing test framework, fixture, naming, mocking, data creation, cleanup, and repository scripts.
- Test observable behavior and stable contracts rather than private methods, call counts, internal ordering, or implementation trivia unless those are the actual contract.
- Keep tests deterministic and isolated. Control time, randomness, network, filesystem, shared database state, and external services using project-supported mechanisms when they materially affect repeatability.
- Prefer fakes/fixtures at real boundaries. Do not over-mock the unit until the test only proves its own setup.
- Never weaken assertions, remove coverage, skip/quarantine tests, add arbitrary sleeps/retries, or catch failures merely to obtain green output.
- Separate pre-existing failures from slice-caused failures using reproducible evidence.

## Quality coverage gate

When relevant to the changed implementation, ensure evidence can expose more than happy-path correctness:

- malformed/invalid input and boundary values;
- denied authorization/tenant ownership;
- not-found/conflict/error mapping;
- async cancellation, stale result, cleanup, or lifecycle behavior;
- persistence constraints, transaction/partial failure, N+1-sensitive behavior through an appropriate integration/query assertion when material;
- duplicate/retry/idempotency or concurrency behavior when the change owns those semantics;
- regression for the specific defect being fixed.

Do not write a test for every quality smell. Use static review/analyzers for structural issues and tests for observable behavior. For example, a unit test should not be contorted merely to count lines or enforce one-type-per-file.

## Test-code quality gate

Reject or correct tests that are materially:

- flaky, timing-dependent, order-dependent, or coupled to shared mutable state;
- so broad that failures cannot localize the changed behavior;
- so implementation-coupled that harmless refactors break them;
- assertion-light snapshots or smoke checks presented as proof of business behavior;
- duplicate tests that add runtime but no distinct evidence;
- dependent on production credentials, uncontrolled external services, or sensitive data.

Test code is production-quality evidence infrastructure: keep helpers and fixtures cohesive, but do not create elaborate test frameworks for a small slice.

## Report

- Record exact commands/actions actually run, environment/target assumptions, and concise pass/fail outcomes.
- State omitted mandatory checks and why they could not be executed. Do not imply coverage from commands that were not run.
- A build proves compilation; lint proves configured static rules; a snapshot proves rendered output at its assertion level. Report each only for what it directly establishes.

## Stop

Return `NEEDS_RETEST_PLAN` when approved evidence cannot prove a criterion, requires unavailable infrastructure, or needs a different bounded validation strategy. Return `NEEDS_REPLAN` when the implementation boundary itself prevents reliable testing or the required change escapes the approved slice.

Completion requires sufficient evidence, not maximum evidence. Prefer a small set of high-signal deterministic checks over a large low-signal suite.
