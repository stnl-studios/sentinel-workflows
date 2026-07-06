---
name: stnl-frontend-react-next-angular
description: Practical frontend rules for scoped React, Next.js, and Angular UI planning, implementation, validation, and review.
---

# React, Next.js, and Angular Frontend

Use only when the approved slice touches one of these frontend stacks.

## Inspect first

- Identify framework/version, rendering mode, router, state/data layer, forms, design system, styling, and test conventions from scoped files.
- Reuse existing components, services, hooks, stores, validators, and tokens before adding abstractions.
- Preserve server/client, container/presentation, and feature/shared boundaries.

## Apply

- Keep data fetching, mapping, state ownership, side effects, and mutation flows explicit.
- Represent loading, empty, error, success, disabled, and permission states required by the contract.
- Prevent stale updates and lifecycle leaks; clean up subscriptions, timers, listeners, and abortable requests.
- Preserve accessibility: semantic elements, labels, keyboard flow, focus behavior, and meaningful status/error feedback.
- Avoid duplicated derived state, unstable list keys, render-time side effects, and unnecessary client-side code.
- For Next.js, respect server/client component and caching boundaries. For Angular, preserve DI, observable, template, and change-detection conventions. For React, preserve hook rules and component responsibility.
- Add focused behavior tests using existing tools; do not test implementation trivia.

## Evidence

Use repository scripts for typecheck, lint, unit/component tests, build, and approved manual flows. Report viewport/browser assumptions for manual evidence when relevant.

## Stop

Return to the Sentinel contract for a design-system change, new package, routing/rendering strategy change, public API change, broad state redesign, security-sensitive UI flow, or undeclared path.
