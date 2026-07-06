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

- `spec.md` or lifecycle-managed `feature_spec.md`: functional contract; only `stnl-spec-lifecycle-manager` may change `feature_spec.md`, including `MODE=CLOSE`.
- `plan-execution.md`: technical contract; planner-only writes.
- `test-plan.md`: evidence contract mapped to acceptance criteria and DoR/DoD; test-planner-only writes.
- `spec-close-inputs.md`: lifecycle close input; finalizer-only writes after validator and reviewer pass.

The finalizer does not edit or close the canonical spec. Never create persistent handoffs, `final.md`, operational logs, or agent history.

## Scope, evidence, and context

Every slice declares concrete allowed, read, and blocked paths. Read the smallest relevant context, change only allowed paths, and never access blocked paths. Stop before following an import, dependency, generated file, migration, security boundary, or architecture path outside the approved contract. Reviewer inspects the current delta, not the repository.

Evidence must identify commands or manual actions actually executed, concise observed results, omissions, and coverage of relevant acceptance criteria and DoR/DoD. A bare claim that tests passed is not evidence; missing mandatory evidence blocks validation.

Load only skills required by the current role and slice. Orchestrator and finalizer load none; coder and validator use migration or security skills only when explicitly required by the plan or diff.

Handoffs are short, textual, disposable, and non-persistent. Use only `PASS`, `BLOCKED`, `NEEDS_APPROVAL`, `NEEDS_FIX`, `NEEDS_REPLAN`, or `NEEDS_RETEST_PLAN`.

After an interruption, reload the approved contracts and existing close inputs, focus on the current slice, and inspect only its partial diff before continuing, cleaning up, or blocking.
