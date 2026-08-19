---
name: stnl-frontend-react-next-angular
description: Scoped React, Next.js, and Angular frontend implementation and review guardrail for component responsibility, state, lifecycle, contracts, accessibility, performance, and evidence.
---

# React, Next.js, and Angular Frontend

Use only when the approved slice touches React, Next.js, or Angular UI code. Preserve approved scope, project conventions, design system, rendering/state architecture, and existing boundaries before applying generic frontend preferences.

## Inspect first

- Identify framework/version, rendering mode, router, state/data layer, forms/validation, component library/design system, styling, API/client layer, localization, and tests from scoped files.
- Read the nearest representative feature and reuse existing components, hooks, stores, services, validators, mappers, tokens, and feedback patterns.
- Preserve established server/client, container/presentation, feature/shared, service/store, and generated-contract boundaries.
- Inspect only enough neighboring code to understand state ownership, lifecycle, and the affected contract.

## Apply

- Keep rendering components focused on rendering and interaction. Do not accumulate networking, persistence, large mapping, authorization decisions, complex orchestration, and unrelated side effects in a page/component.
- Keep feature state ownership explicit. Avoid duplicated derived state, competing sources of truth, mutation hidden in render/computed paths, or synchronization effects that exist only because state was duplicated.
- Prefer cohesive files/components. Multiple small types or components may remain co-located when they form one private feature unit; split independently reusable/public responsibilities when co-location harms ownership, testing, or discovery.
- Reuse the design system and existing feature primitives before adding local duplicates.
- Preserve API/runtime contracts and established mapping boundaries. Do not let raw vendor/persistence DTOs leak into UI when the project maps them.
- Keep deterministic formatting, validation, and state-transition logic testable when practical; do not force abstractions solely for test purity.
- Avoid broad component extraction or generalized hooks/services unless there is actual reuse, responsibility separation, or local precedent.

## State, async, and lifecycle gate

When async/stateful behavior is touched:

- represent the relevant loading, empty, error, success, disabled, validation, permission, retry, and stale/cancelled states rather than only the happy path;
- prevent stale responses from overwriting newer state where requests can race;
- clean up subscriptions, timers, listeners, observers, and abortable work according to framework/project lifecycle;
- avoid duplicate loads caused by unstable effects/hooks, repeated subscriptions, or render-triggered side effects;
- keep mutation/submit ownership and double-submit prevention explicit when applicable;
- preserve user input across validation/error/loading transitions when the UX requires it.

For React, preserve hook rules and stable dependency semantics. For Next.js, respect server/client component, data-fetching, cache/revalidation, and serialization boundaries. For Angular, preserve DI scope, observable ownership, template conventions, signals/change detection, and subscription cleanup used by the project.

## Component and function quality gate

Inspect modified components, hooks, services, stores, and functions for responsibility overload rather than using a fixed line threshold.

Strong smells include:

- one component owns data fetching, normalization, complex business decisions, form rules, navigation, analytics, and large rendering trees;
- a hook/store/service becomes a procedural feature script with unrelated responsibilities;
- deeply nested conditionals or effects make state transitions difficult to reason about;
- repeated mapping/validation/business rules appear across components;
- many props/dependencies exist because boundaries are misplaced rather than because the UI is legitimately rich.

Split only along meaningful project-aligned boundaries. A long but cohesive render/transform function is not automatically a failure.

## Accessibility and UX gate

For touched UI:

- use semantic controls/elements, associated labels, keyboard behavior, focus management, and meaningful status/error feedback;
- preserve disabled/loading semantics and avoid interaction states that are visual only;
- maintain design-system accessibility, localization, formatting, and responsive behavior;
- do not introduce clickable non-controls or remove accessible names/relationships without an equivalent accessible behavior.

## Performance gate

Only optimize when the changed path presents a real risk. Check for:

- accidental repeated network requests or subscriptions;
- unbounded client-side collections or expensive filtering/rendering;
- unstable keys or recreated state that causes incorrect lifecycle behavior;
- heavy work performed during render/change detection;
- unnecessary client-side code in Next.js where server execution is the established boundary;
- memoization/cache complexity added without demonstrated benefit.

Prefer correctness and clear ownership over speculative micro-optimization.

## Quality smells

Reject or correct material instances of:

- massive page/component/store/service with mixed responsibilities;
- lifecycle leaks or stale async updates;
- render-time side effects;
- duplicated sources of truth or derived state;
- raw API/vendor contract leakage against project convention;
- local design-system bypass;
- hidden validation or submit behavior;
- accessibility regressions in touched UI;
- unnecessary abstraction/generalization;
- out-of-scope visual or architecture refactoring.

## Evidence

- Run the narrowest repository-defined typecheck, lint, unit/component tests, build, and approved manual flows relevant to the change.
- Test observable behavior and state transitions, not implementation trivia.
- When manual UI evidence matters, state route/flow, viewport/browser assumptions, and observable result.
- A snapshot or successful build does not by itself prove accessibility, lifecycle, async ordering, or user behavior.

## Stop

Return to the Sentinel contract for a design-system change, new dependency, routing/rendering strategy change, undeclared public API/schema change, broad state-management redesign, security-sensitive flow change, framework upgrade, cross-feature architecture shift, or path outside the approved slice.

Completion requires behavior plus structural quality. A visually working screen is not a pass when it introduces material lifecycle leaks, stale state, responsibility overload, accessibility regression, contract leakage, duplicate state, or project-boundary bypass.
