---
name: stnl-backend-node-typescript
description: Practical Node.js and TypeScript backend rules for scoped services, APIs, workers, and their tests.
---

# Node.js and TypeScript Backend

Use only when the approved slice touches a Node.js/TypeScript backend.

## Inspect first

- Read scoped package manifests, TypeScript configuration, framework entry points, and existing scripts.
- Follow current module format, package manager, layer boundaries, dependency injection, validation, error handling, logging, and test patterns.
- Treat TypeScript types and runtime validation as different contracts.

## Apply

- Keep transport, application, domain, and persistence responsibilities in their established layers.
- Validate untrusted input at runtime and preserve API/error/serialization contracts unless the plan changes them.
- Keep async failures observable; await promises, preserve error causes where supported, and clean up resources/listeners.
- Avoid unsafe type assertions, broad `any`, import-cycle workarounds, hidden mutable globals, and unbounded concurrency.
- Use existing configuration and secret-loading mechanisms. Never embed credentials.
- Keep data access bounded and transaction ownership explicit. Use the database skill only when persistence/migrations are approved.
- Add focused tests through repository-defined scripts.

## Evidence

Run the narrowest applicable typecheck, lint, test, and build scripts. State exact commands, affected package/workspace, and concise results. Do not substitute a transpile success for typecheck or test evidence.

## Stop

Return to the Sentinel contract for a runtime/framework/package-manager upgrade, new dependency, public API/schema change, migration, auth change, cross-package architecture change, or undeclared path.
