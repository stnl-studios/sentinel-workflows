---
name: stnl-backend-dotnet
description: Scoped .NET/C# backend implementation and review guardrail for architecture, DI, contracts, async behavior, persistence boundaries, maintainability, and evidence.
---

# .NET Backend

Use only when the approved slice touches .NET/C# backend code. The approved scope is authoritative; existing project conventions come next. Improve structural quality inside that boundary without introducing a preferred architecture or unrelated refactor.

## Inspect first

- Identify the solution/project, target framework, scoped entrypoints, application/domain/infrastructure boundaries, DI registrations, configuration, error handling, logging, validation, authorization, persistence, and tests.
- Read the nearest representative implementation before creating a new pattern. Prefer the dominant, newer, or area-local convention when multiple patterns exist.
- Check repository-defined build, format, analyzer, and test commands before inventing commands or tooling.
- Inspect only enough surrounding code to understand the changed contract and its direct dependencies; do not explore the repository broadly without a concrete need.

## Apply

- Keep controllers, endpoints, handlers, jobs, and resolvers thin. Do not place business decisions, persistence orchestration, heavy mapping, or unrelated side effects at the transport boundary.
- Keep application/domain/infrastructure responsibilities in their established boundaries. A method or class that accumulates unrelated validation, authorization, business decisions, persistence, integration, mapping, and notification is a decomposition smell.
- Prefer cohesive files and types. Multiple interfaces, records, DTOs, or models in one file are acceptable when tightly related and consistent with the project; split independent public contracts or unrelated types when co-location harms discovery, ownership, or change isolation.
- Preserve public API, serialization, nullability, exception, configuration, and compatibility contracts unless the approved plan explicitly changes them.
- Use async I/O end-to-end. Propagate `CancellationToken` where the local contract supports it; avoid sync-over-async, fake async, accidental fire-and-forget, and work that outlives its owner without intent.
- Preserve deterministic business logic as independently testable code when practical. Do not force pure functions everywhere, but avoid mixing calculation/decision logic with database, network, clock, filesystem, or messaging effects when the separation is natural in the local architecture.
- Do not add broad abstractions, interfaces, factories, mappers, repositories, or services only to satisfy a generic pattern. Add the smallest structure that resolves a real responsibility, contract, reuse, or testability problem.

## DI and ownership gate

When dependencies or service registration are touched, reject or correct:

- service locator usage such as resolving application dependencies through `IServiceProvider` inside business flow without an established local reason;
- manual construction that bypasses existing DI/configuration ownership;
- incompatible lifetimes, especially longer-lived services capturing scoped/request-owned dependencies;
- hidden mutable global/static state used as dependency replacement;
- concrete coupling that bypasses an established boundary without justification;
- constructors or services with dependency growth that reveals mixed responsibilities.

Do not create an interface merely because a class is injected. Follow project conventions and add an abstraction only when it represents a real boundary, substitution point, or testability need.

## Conditional quality gates

Apply only the gates activated by the changed surface:

- **Persistence:** avoid N+1, query/write inside loops when batching is practical, early materialization, excessive eager loading, unbounded result sets, filtering large data in memory, or bypassing the established persistence boundary. Use `stnl-database-persistence` when persistence or migration work is explicitly in scope.
- **Multiple writes or side effects:** make atomicity, transaction ownership, retry/idempotency, partial failure, and external-call placement intentional.
- **External integration:** keep vendor DTOs/errors out of domain/public contracts when the project has a mapping boundary; normalize failures and sanitize logs.
- **Authorization:** authentication is not authorization. Derive actor/tenant/ownership from authenticated context rather than trusting client-supplied identity. Use `stnl-security-auth` when the security boundary itself changes.
- **Public contract:** check compatibility, serialization, nullability, validation, mapping, versioning, and affected tests/clients before accepting the change.
- **Resources/lifecycle:** dispose owned resources correctly and do not introduce hidden background work, listeners, or long-lived state without ownership.

## Quality smells

Before considering the implementation complete, inspect the changed code for:

- oversized methods/classes with multiple reasons to change;
- deeply nested or duplicated decision logic;
- misplaced DI or lifetime ownership;
- anemic wrappers or abstractions that only add indirection;
- mixed deterministic logic and side effects that make small rules hard to test;
- N+1 or unbounded data access;
- domain/persistence/vendor models leaking through the wrong boundary;
- catch-all exception handling, swallowed failures, or sensitive logging;
- magic strings/configuration that should use the project's existing mechanisms;
- out-of-scope cleanup disguised as implementation work.

Do not fail solely on line count, number of constructor parameters, or number of types per file. Use those as signals and judge cohesion, responsibility, project convention, and maintenance cost.

## Evidence

- Run the narrowest applicable restore/build/analyzer/test commands that prove the changed behavior and contracts.
- Add or update focused tests for meaningful success, failure, boundary, regression, authorization, or persistence behavior as applicable.
- Report exact commands, scoped project/package, and concise outcomes. Never imply that a broader command ran when it did not.
- A successful build proves compilation, not behavioral correctness or structural quality.

## Stop

Return to the Sentinel contract instead of improvising when the implementation requires a framework/runtime upgrade, new package or project reference, undeclared public contract change, migration, auth model change, architecture shift, new cross-service boundary, destructive persistence change, or path outside the approved slice.

Completion requires both behavioral evidence and structural quality. Working code is not a pass when it introduces a material DI/lifetime defect, N+1/unbounded access, broken contract, unsafe async/resource ownership, responsibility overload, security regression, or unnecessary architecture.
