# Sentinel Workflows for GitHub Copilot

Sentinel Workflows is a small, contract-based execution workflow for scoped software changes. Copy this target into a project and use the supplied Copilot agents, instructions, and skills directly; no generator or additional runtime is required.

All workflow files and generated contract content are written in English.

## Workflow

Run phases only in this order:

```text
orchestrator
  -> planner
  -> developer approval
  -> test-planner
  -> developer approval
  -> coder
  -> validator
  -> reviewer
  -> finalizer
```

The orchestrator routes; it does not perform another agent's work. A plan change returns to developer approval. A test-plan change returns to developer approval. Scope or architecture uncertainty stops for a developer decision.

Do not start this workflow from free conversation alone. Start with an explicit spec and phase/slice request, then use the matching agent. Do not skip agents or approvals.

## Persistent contracts

- `spec.md`: functional contract. If the project uses `stnl-spec-lifecycle-manager`, its canonical `feature_spec.md` is the equivalent and must keep that lifecycle's structure.
- `plan-execution.md`: developer-approved technical contract, split into small slices with allowed, read, and blocked paths.
- `test-plan.md`: developer-approved evidence contract, mapped to acceptance criteria and DoD.
- `spec-close-inputs.md`: minimal evidence prepared by the finalizer for lifecycle close; it is not a report or the final spec.

Keep operational state, logs, diffs, and agent history out of the spec and these artifacts. Never create persistent handoff files or `final.md`.

## Human gates

The developer must approve `plan-execution.md` before test planning and approve `test-plan.md` before coding. Any later change to either contract repeats its gate. Dependencies, scope expansion, major architecture choices, and new allowed paths also require explicit approval.

## Operating model

1. Give the planner the functional contract and current slice. Approve its concrete plan.
2. Give the test-planner the approved plan. Approve its evidence contract.
3. Give the coder only the approved current slice and declared paths.
4. Require objective command/results evidence from the validator.
5. Have the reviewer inspect the delta, not the repository.
6. Let the finalizer update only `spec-close-inputs.md` after validator and reviewer pass.
7. Use `stnl-spec-lifecycle-manager` `MODE=CLOSE` only after close inputs say `ready-to-close`.

Handoffs are short and disposable. Use only `PASS`, `BLOCKED`, `NEEDS_APPROVAL`, `NEEDS_FIX`, `NEEDS_REPLAN`, and `NEEDS_RETEST_PLAN`.

## Recovery

After an interrupted or partial run, reload the functional spec, approved plan, approved test plan, and existing close inputs; focus on the current slice; inspect only its partial diff; then continue, clean up, or block. Approved contracts are reusable. Unreliable partial implementation is disposable.
