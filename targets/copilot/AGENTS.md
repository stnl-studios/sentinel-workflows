# Sentinel Workflows for GitHub Copilot

Use English for workflow artifacts. Start an explicit Sentinel request with `sentinel-orchestrator`; specialist agents are orchestration-only and must not be invoked directly. Do not execute a phase from free conversation.

## Workflow and gates

Run only this sequence:

```text
orchestrator -> planner -> developer approval -> test-planner
  -> developer approval -> coder -> validator -> reviewer -> developer completion
```

Only the orchestrator may invoke another Sentinel agent, and it may invoke only the next eligible role. The reviewer is the last agent. Specialists do not invoke agents. The developer must approve `plan-execution.md` before test planning and `test-plan.md` before coding; changing either contract repeats its approval gate. Scope expansion, new paths, dependencies, or major architecture decisions require developer approval.

## Contracts and ownership

- `spec.md` or lifecycle-managed modular spec workspace: functional contract; operational `feature_spec.md` is a compact index.
- `feature_spec.md`, `shared/`, `slices/`, `lifecycle/`, and `spec.md`: developer or `stnl-spec-lifecycle-manager` when explicitly invoked. No execution agent may modify them.
- `shared/acceptance-criteria.md`: never alter acceptance criteria to hide implementation drift.
- `slices/SL-###.md`: only the developer marks a slice `done` after Validator and Reviewer pass.
- `plan-execution.md`: technical contract; planner-only writes.
- `test-plan.md`: evidence contract mapped to acceptance criteria and DoR/DoD; test-planner-only writes.

Never create persistent handoffs, slice context package files, close-input files, `final.md`, operational logs, or agent history.

After Validator `PASS` and Reviewer `PASS`, the reviewer returns a compact final handoff with satisfied ACs, Validator and Reviewer status, mandatory evidence summary, DoD status, accepted risks, durable discovery candidates, follow-ups, blockers, changed paths, and the next manual action. The orchestrator then returns `NEEDS_APPROVAL`, `Current phase: developer-completion`, `Next agent: none`, and tells the developer to apply the Developer Completion Protocol.

The developer completes the slice manually by confirming Validator `PASS`, Reviewer `PASS`, mandatory evidence, AC satisfaction, and applicable DoD; marking the slice `done`; filling compact `completion_summary`; recording accepted risks and durable discoveries; updating traceability, QA, resume notes, and compact index metadata; and creating only necessary follow-up slices. If an AC, requirement, or scope must change, do not complete the slice; return to `MODE=RESUME`.

## Scope, evidence, and context

Every slice declares concrete allowed, read, and blocked paths. Read the smallest relevant context, change only allowed paths, and never access blocked paths. The orchestrator may search IDs and read only explicitly linked spec blocks to build an in-memory package; it must not judge, modify, or expand them. Stop before following an import, dependency, generated file, migration, security boundary, or architecture path outside the approved contract. Reviewer inspects the current delta, not the repository.

Evidence must identify commands or manual actions actually executed, concise observed results, omissions, and coverage of relevant acceptance criteria and DoR/DoD. A bare claim that tests passed is not evidence; missing mandatory evidence blocks validation.

Load only skills required by the current role and slice. Orchestrator loads none; coder and validator use migration or security skills only when explicitly required by the plan or diff.

Handoffs are short, textual, disposable, and non-persistent. Use only `PASS`, `BLOCKED`, `NEEDS_APPROVAL`, `NEEDS_FIX`, `NEEDS_REPLAN`, or `NEEDS_RETEST_PLAN`.

The spec-state atomicity rule means the spec does not advance automatically during execution; it is not a filesystem transaction. Partial code may remain in the working tree, but partial work is never recorded as completed. After an interruption, reload the compact spec index, current slice package, traceability, QA, resume notes, and approved contracts; detect any partial manual spec update before continuing, cleaning up, blocking, or restoring consistency directly or through `MODE=RESUME`.
