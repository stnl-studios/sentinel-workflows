---
name: stnl-backend-dotnet
description: Practical .NET backend rules for scoped planning, implementation, validation, and review of C# services and APIs.
---

# .NET Backend

Use only when the approved slice touches .NET/C# backend code.

## Inspect first

- Identify the solution/project files and target framework from scoped paths.
- Follow existing project layering, dependency direction, dependency injection, error handling, and test conventions.
- Check repository-defined build, format, test, and analyzer commands before proposing new ones.

## Apply

- Keep domain/application/infrastructure responsibilities in their existing boundaries.
- Preserve public API, serialization, nullability, cancellation, and exception contracts unless the plan explicitly changes them.
- Use asynchronous APIs end-to-end for I/O; propagate `CancellationToken` where the local contract supports it.
- Prefer existing DI registrations and configuration patterns. Do not create service locators or hidden global state.
- Make validation and authorization explicit at the established boundary.
- Keep queries bounded and avoid accidental N+1 access. Use the database skill when persistence or migrations are explicitly in scope.
- Add focused tests using the project's framework and conventions.

## Evidence

Prefer the narrowest applicable restore/build/test/analyzer commands. Report exact commands and concise results. If a full solution command is required but outside the slice budget or unavailable, state that gap; do not imply it ran.

## Stop

Return to the Sentinel contract when work requires a framework upgrade, new package, project reference, public contract change, migration, authentication change, architecture shift, or path outside the approved slice.
