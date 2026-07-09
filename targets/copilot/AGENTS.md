# Sentinel Workflows for GitHub Copilot

Use English for workflow artifacts. Start an explicit Sentinel request with `sentinel-orchestrator`; specialist agents are orchestration-only and must not be invoked directly. Do not execute a phase from free conversation.

## Workflow and gates

Run only this sequence:

```text
orchestrator -> planner -> developer approval -> test-planner
  -> developer approval -> coder -> validator -> reviewer -> finalizer
```

Only the orchestrator may invoke another Sentinel agent, and it may invoke only the next eligible role. Specialists do not invoke agents. The developer must approve `plan-execution.md` before test planning and `test-plan.md` before coding; changing either contract repeats its approval gate. Scope expansion, new paths, dependencies, or major architecture decisions require developer approval.

## Contracts and ownership

- `spec.md` or lifecycle-managed modular spec workspace: functional contract; operational `feature_spec.md` is a compact index.
- `shared/acceptance-criteria.md`: lifecycle/spec management only.
- `shared/decisions.md`, `shared/constraints.md`, `shared/risks.md`: lifecycle/spec management; finalizer may append durable artifacts after a successful round.
- `shared/questions.md`: lifecycle/spec management only.
- `slices/SL-###.md`: lifecycle/spec management; finalizer may mark the completed slice done and create necessary follow-up slices.
- `lifecycle/traceability.md`, `lifecycle/qa-checklist.md`, `lifecycle/resume-notes.md`: lifecycle/spec management; finalizer may update after a successful round.
- `plan-execution.md`: technical contract; planner-only writes.
- `test-plan.md`: evidence contract mapped to acceptance criteria and DoR/DoD; test-planner-only writes.

The finalizer applies one atomic modular spec update only after validator and reviewer both pass. It does not close the spec, change acceptance criteria to hide drift, remove operational directories, or invoke `MODE=CLOSE`. Never create persistent handoffs, slice context package files, close-input files, `final.md`, operational logs, or agent history.

## Scope, evidence, and context

Every slice declares concrete allowed, read, and blocked paths. Read the smallest relevant context, change only allowed paths, and never access blocked paths. Stop before following an import, dependency, generated file, migration, security boundary, or architecture path outside the approved contract. Reviewer inspects the current delta, not the repository.

Evidence must identify commands or manual actions actually executed, concise observed results, omissions, and coverage of relevant acceptance criteria and DoR/DoD. A bare claim that tests passed is not evidence; missing mandatory evidence blocks validation.

Load only skills required by the current role and slice. Orchestrator and finalizer load none; coder and validator use migration or security skills only when explicitly required by the plan or diff.

Handoffs are short, textual, disposable, and non-persistent. Use only `PASS`, `BLOCKED`, `NEEDS_APPROVAL`, `NEEDS_FIX`, `NEEDS_REPLAN`, or `NEEDS_RETEST_PLAN`.

After an interruption, reload the compact spec index, current slice package, approved contracts, focus on the current slice, and inspect only its partial diff before continuing, cleaning up, or blocking.
