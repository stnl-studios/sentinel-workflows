---
name: stnl-mobile-ios-swift
description: Scoped iOS/Swift implementation and review guardrail for state ownership, concurrency, lifecycle, navigation, contracts, persistence boundaries, platform quality, and evidence.
---

# iOS Swift

Use only when the approved slice touches iOS/Swift code. Preserve the project's SwiftUI/UIKit architecture, navigation, dependency composition, design system, persistence/network boundaries, and testing conventions before applying generic preferences.

## Inspect first

- Identify Swift/SDK targets, SwiftUI/UIKit usage, state ownership pattern, navigation/coordinator pattern, dependency injection/composition, networking/client layer, local persistence, design system, localization, and tests.
- Read the nearest representative screen/feature and reuse established Views/ViewControllers, ViewModels/Stores/Presenters, Services/Clients/Repositories, Coordinators/Routers, mappers, and components.
- Determine actor/lifecycle ownership for changed asynchronous work before adding `Task`, streams, callbacks, timers, observers, or subscriptions.
- Inspect only the dependency surface needed to understand the changed behavior and ownership.

## Apply

- Keep Views/ViewControllers focused on rendering, user interaction, and lifecycle responsibilities appropriate to the local architecture. Do not collapse networking, persistence, business rules, mapping, navigation, and analytics into one UI object.
- Avoid Massive ViewController and Massive ViewModel/Store/Presenter designs. Split when one owner accumulates multiple unrelated reasons to change; follow local boundaries rather than introducing a new architecture.
- Prefer cohesive files/types. Multiple small related models/protocols may be co-located when they form one feature contract; split independent public responsibilities when co-location damages discovery or ownership.
- Keep deterministic validation, mapping, formatting, and state decisions independently testable where the local pattern supports it. Do not force pure functions or protocols where they add no real boundary.
- Reuse existing design-system components, tokens, navigation, networking, persistence, and dependency mechanisms before creating alternatives.
- Do not add coordinators, repositories, protocols, dependency containers, or mappers merely because another architecture would use them.

## State ownership and concurrency gate

When async/state work is touched:

- keep UI-published state on the appropriate actor, using `@MainActor` where required by the project/Swift concurrency model;
- avoid unsafe cross-actor mutation and do not use `Task.detached` or unstructured `Task {}` without ownership reasoning;
- handle async errors intentionally and cancellation when work may outlive the screen/request;
- avoid duplicate loads caused by careless `.task`, `.onAppear`, re-rendering, or repeated binding/state updates;
- prevent stale work from publishing into a no-longer-current screen/state;
- avoid `try!`, force unwrap, or `fatalError` in normal product flow unless an invariant is truly guaranteed and consistent with project practice.

## Lifecycle and memory gate

If the change creates or modifies a `Task`, Combine subscription, timer, observer, delegate, async sequence, stream, callback, or escaping closure, define its ownership and cleanup.

Reject or correct:

- retain cycles or accidental strong captures;
- subscriptions/timers/observers that outlive their owner;
- delegates retained or left attached incorrectly;
- tasks that should cancel but continue after disappearance/deallocation;
- callbacks that publish stale UI state;
- hidden long-lived work with no lifecycle owner.

Do not require cleanup when the API/project model proves lifecycle ownership automatically; require understanding, not ceremony.

## Navigation and presentation gate

- Keep navigation in the existing coordinator/router/navigation boundary when one exists.
- Do not navigate or dismiss as an opaque side effect inside networking/persistence layers.
- Make success, error, cancellation, modal/sheet/alert/dismiss paths explicit where relevant.
- Preserve back navigation, deep-link/restoration behavior, and presentation ownership when the changed flow depends on them.

## Forms and UI-state gate

For touched flows, handle or explicitly determine applicability of loading, empty, error, disabled, validation, success, cancellation, offline/stale-cache, unauthorized/permission, and retry states.

- Preserve user input across loading/validation/error transitions when appropriate.
- Keep field errors and double-submit behavior explicit.
- Preserve keyboard, focus, submit, and dismiss behavior according to project conventions.
- Avoid duplicated validation logic across views when the project has a reusable boundary.

## Contracts, networking, and persistence gate

- Do not perform direct networking or persistence from UI when the project has a Service/Client/Repository/storage boundary.
- Keep request construction, response interpretation, error normalization, and nontrivial mapping out of render code when a lower boundary exists.
- Preserve generated clients/schema contracts and do not silently hide decoding/contract errors with unsafe fallbacks.
- Keep API/persistence DTOs out of UI when the project uses domain/view-state mapping.
- Preserve cache invalidation, storage security, key naming, migration, and synchronization patterns when touched.

## Platform and accessibility gate

For touched UI preserve:

- native interaction expectations and project design system;
- Dynamic Type, VoiceOver labels/relationships, hit targets, focus behavior, and contrast;
- localization and project formatting for strings, dates, numbers, currencies, and units;
- reusable components instead of local visual/behavior duplicates.

## Quality smells

Inspect changed code for:

- massive ViewController/ViewModel/Store/Presenter;
- mixed UI, networking, persistence, navigation, mapping, validation, and analytics;
- unsafe actor/UI mutation or unowned lifecycle work;
- duplicate loads or stale async publication;
- retain-cycle risk;
- hidden navigation side effects;
- DTO/persistence contract leakage;
- happy-path-only UI;
- unnecessary protocols/abstractions;
- broad refactor outside the approved slice.

Do not fail solely on file length, type count, or dependency count. Judge cohesion, ownership, lifecycle safety, local conventions, and maintenance risk.

## Evidence

- Run the narrowest applicable build, unit test, UI/snapshot test, lint/static-analysis, and approved manual flow supported by the repository.
- Add focused tests for state transitions, validation, mapping, async success/error/cancellation, navigation decisions, and regressions when those are the changed risks.
- State exact commands/schemes/targets and concise outcomes. Manual evidence should state device/simulator and observable flow when relevant.

## Stop

Return to the Sentinel contract for an iOS/Swift toolchain or deployment-target change, new package/dependency, navigation architecture change, public/generated contract change, auth/security model change, persistence migration, broad state architecture redesign, or undeclared path.

Completion requires behavior plus structural, lifecycle, concurrency, and platform quality. A flow that works is not a pass when it creates material actor violations, lifecycle leaks, responsibility overload, contract leakage, inaccessible UI, or architecture bypass.
