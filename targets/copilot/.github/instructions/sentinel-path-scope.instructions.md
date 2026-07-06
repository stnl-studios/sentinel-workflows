---
applyTo: "**"
---

# Sentinel Path Scope

Every execution slice must declare concrete allowed paths, read paths, and blocked paths.

- Allowed paths may be read and changed only for approved slice work.
- Read paths may be inspected but not changed.
- Blocked paths may not be read or changed.
- Any path not declared is out of scope until the planner updates the plan and the developer approves it.
- Prefer the smallest relevant file set. Do not search or review the whole repository.
- Stop before following an import, dependency, generated file, migration, security boundary, or architecture path outside the contract.

Report actual changed paths and any path-scope violation in the handoff. Never hide opportunistic work inside an approved path.
