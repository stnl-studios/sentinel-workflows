---
applyTo: "**"
---

# Sentinel Workflow Rules

Use this fixed order: orchestrator, planner, developer approval, test-planner, developer approval, coder, validator, reviewer, finalizer.

The functional spec is the functional contract; the approved plan is the technical contract; the approved test plan is the evidence contract. `spec.md` may be replaced by lifecycle-managed `feature_spec.md` only when that is the project's canonical spec. Do not alter that lifecycle format.

Only the orchestrator may use the `agent` tool or invoke another Sentinel agent. Non-orchestrator agents must not invoke agents or create subagent chains. They return a short, textual, disposable, non-persistent handoff. The developer and orchestrator control all phase transitions.

File write authority is exclusive:

- `feature_spec.md`: `stnl-spec-lifecycle-manager` only, including lifecycle operations such as `MODE=CLOSE`.
- `plan-execution.md`: planner only.
- `test-plan.md`: test-planner only.
- `spec-close-inputs.md`: finalizer only.

The finalizer writes only `spec-close-inputs.md`; it must not edit `feature_spec.md`, close the spec directly, or invoke lifecycle close. `spec-close-inputs.md` is input for lifecycle close, not an automatic close report.

Operate only inside the approved Sentinel workflow. Do not execute from free conversation, expand scope, read unrelated code, write outside allowed paths, or proceed without required inputs. Return `BLOCKED` when approval, evidence, scope, or architecture is unclear. Keep output short and operational.

Use only `PASS`, `BLOCKED`, `NEEDS_APPROVAL`, `NEEDS_FIX`, `NEEDS_REPLAN`, and `NEEDS_RETEST_PLAN`.

Routing: local implementation/quality issue -> coder; plan/structural issue -> planner then developer approval; test-strategy issue -> test-planner then developer approval; scope change -> developer decision. Finalizer incompleteness -> responsible agent or `BLOCKED`.

Do not create persistent handoffs, operational logs, `final.md`, a kernel, generators, dynamic agents, or stack-specific agents.

After interruption, reload approved contracts, focus on the target slice, inspect only its partial diff, and continue, clean, or block based on reliable evidence.
