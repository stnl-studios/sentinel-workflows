---
name: stnl-backend-node-typescript
description: Scoped Node.js/TypeScript backend implementation and review guardrail for contracts, async ownership, DI, data access, maintainability, runtime safety, and evidence.
---

# Node.js and TypeScript Backend

Use only when the approved slice touches a Node.js/TypeScript backend. The approved scope defines what may change; existing project conventions define how it should fit. Do not turn a scoped change into a framework or architecture rewrite.

## Inspect first

- Identify package/workspace boundaries, Node and TypeScript versions, module format, framework entrypoints, dependency injection/composition, runtime validation, error/logging patterns, persistence, configuration, and tests.
- Read the nearest representative implementation and reuse established services, schemas, repositories, mappers, clients, utilities, and scripts before adding abstractions.
- Treat TypeScript types and runtime validation as different contracts. A static type does not validate untrusted runtime input.
- Inspect the smallest dependency surface required to understand the change; expand only for a concrete contract or ownership question.

## Apply

- Keep route/controller/handler code thin and preserve established transport, application, domain, integration, and persistence boundaries.
- Avoid giant procedural services or handlers that combine parsing, validation, authorization, business decisions, persistence, integration, mapping, and side effects without a clear local boundary.
- Prefer cohesive modules. Multiple related types/interfaces in one file are fine when they form one contract or feature unit; split independent contracts or unrelated models when co-location obscures ownership or increases coupling.
- Validate untrusted input at runtime using the project's established mechanism and preserve API/error/serialization contracts unless the approved plan changes them.
- Keep async failures observable: await owned promises, preserve error causes where supported, clean up resources/listeners, and avoid accidental fire-and-forget.
- Avoid broad `any`, unjustified type assertions, unsafe casts, import-cycle workarounds, mutable globals, and runtime assumptions hidden behind static types.
- Keep deterministic decision/calculation logic separable from I/O when that naturally improves responsibility and testability. Do not force functional style where the project does not use it.
- Add the smallest sufficient abstraction. Do not add interfaces, factories, repositories, adapters, or helper layers only for stylistic purity.

## DI, composition, and lifecycle gate

When dependency composition or resource ownership is touched, reject or correct:

- service-locator/container lookups hidden inside business code when normal injection/composition exists;
- direct construction that bypasses configured dependencies or makes lifecycle ownership ambiguous;
- request-scoped state captured by singleton/global objects;
- shared mutable module state used as implicit dependency injection;
- listeners, streams, timers, sockets, subscriptions, workers, or abortable requests with no cleanup/ownership;
- dependency growth that signals one service owns unrelated responsibilities.

Use the framework/project composition model rather than introducing another container or pattern.

## Conditional quality gates

Apply only when the changed surface activates them:

- **Persistence:** reject N+1, database/API reads inside loops when batching is practical, early materialization, unbounded `Promise.all`, unbounded result sets, large in-memory filtering, or persistence-boundary bypass. Use `stnl-database-persistence` for approved persistence/migration work.
- **Concurrency:** bound parallel work, preserve ordering when required, propagate `AbortSignal`/cancellation where established, and make retry/idempotency behavior explicit for repeatable effects.
- **External integration:** isolate vendor contracts when the project has an adapter/mapping boundary; normalize errors and do not leak secrets or raw vendor payloads.
- **Authorization:** use authenticated server context for actor/tenant/ownership decisions. Use `stnl-security-auth` when the security boundary changes.
- **Public contract:** check schema/runtime validation, optionality, serialization, compatibility, consumers, and tests.
- **Multiple effects:** make transaction or compensation ownership, partial failure, retry, duplicate delivery, and event publication behavior intentional.

## Quality smells

Inspect changed code for:

- oversized functions/classes/modules with multiple reasons to change;
- repeated conditionals or mapping/business rules;
- deeply nested promise/control flow that hides failure behavior;
- mixed business logic and I/O that prevents focused testing;
- N+1, unbounded concurrency, unbounded reads, or repeated remote calls;
- DTO/domain/persistence/vendor contract leakage;
- hidden mutable globals or implicit request state;
- catch-and-ignore behavior or generic error replacement that destroys useful context;
- unnecessary wrappers/abstractions that add indirection but no boundary;
- broad refactoring outside the approved slice.

Do not fail solely because a function is long, a constructor has many parameters, or a module contains several related types. Those are signals; judge cohesion, complexity, local convention, and maintenance risk.

## Evidence

- Run the narrowest repository-defined typecheck, lint, test, and build commands applicable to the changed package/workspace.
- Add focused tests for meaningful behavior and boundaries. Do not substitute transpilation, snapshots, or mocks for behavior they do not prove.
- State exact commands, affected workspace/package, and concise results. Separate pre-existing failures from slice-caused failures with evidence.

## Stop

Return to the Sentinel contract for a Node/runtime/framework/package-manager upgrade, new dependency, undeclared public API/schema change, migration, auth model change, cross-package architecture shift, new infrastructure boundary, destructive persistence change, or path outside the approved slice.

Completion requires behavioral evidence and structural quality. Passing tests do not excuse material runtime-validation gaps, lifecycle leaks, unbounded work, N+1, broken contracts, misplaced composition, or responsibility overload.
