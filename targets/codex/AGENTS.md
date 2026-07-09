# Sentinel Workflows Basic for Codex

Sentinel Workflows Basic is a contract-driven workflow for executing approved feature slices with explicit human gates, bounded paths, objective evidence, and disposable handoffs. The spec slice package, approved technical plan, and approved test plan are the authorities for execution. Free conversation alone never authorizes a phase.

## Target layout

- `AGENTS.md`: project guidance for the Codex target.
- `.codex/config.toml`: bounded subagent settings.
- `.codex/agents/*.toml`: project-scoped Sentinel agent contracts.
- `.agents/skills/*/SKILL.md`: progressively loaded technical skills.

All target files and generated workflow artifacts must be written in English.

## Fixed workflow

```text
orchestrator
  -> planner
  -> developer approval
  -> test-planner
  -> developer approval
  -> coder
  -> validator
  -> reviewer
  -> developer completion
```

The spec workspace is modular. Operational `feature_spec.md` is a compact index; the orchestrator prepares the current slice package from `feature_spec.md`, `slices/SL-###.md`, and explicitly linked shared artifact blocks. The orchestrator may read and extract linked content, but must not judge it, modify it, expand it, inspect source code, or create a persistent context package. The approved plan is the technical contract. The approved test plan is the evidence contract. The coder executes only approved slices. Validator and reviewer do not edit code. Any scope, plan, test, dependency, or architecture change returns to developer approval.

## Persistent artifacts and authority

| Artifact | Write authority |
|---|---|
| operational `feature_spec.md` index | developer or `stnl-spec-lifecycle-manager` when explicitly invoked |
| `shared/acceptance-criteria.md` | developer or `stnl-spec-lifecycle-manager`; never to hide implementation drift |
| `shared/decisions.md`, `shared/constraints.md`, `shared/risks.md` | developer or `stnl-spec-lifecycle-manager` when explicitly invoked |
| `shared/questions.md` | developer or `stnl-spec-lifecycle-manager` when explicitly invoked |
| `slices/SL-###.md` | developer or `stnl-spec-lifecycle-manager`; only the developer marks a slice `done` after Validator and Reviewer pass |
| `lifecycle/traceability.md`, `lifecycle/qa-checklist.md`, `lifecycle/resume-notes.md` | developer or `stnl-spec-lifecycle-manager` when explicitly invoked |
| `spec.md` | developer or `stnl-spec-lifecycle-manager` when explicitly invoked |
| `plan-execution.md` | planner only |
| `test-plan.md` | test-planner only |

The workspace of the spec may be changed only by the developer or by `stnl-spec-lifecycle-manager` when explicitly invoked. No execution agent may modify `feature_spec.md`, `shared/`, `slices/`, `lifecycle/`, or `spec.md`.

Never create `final.md`, close-input files, persistent handoff files, slice context package files, or operational-history artifacts.

## Developer completion

After Validator `PASS` and Reviewer `PASS`, the reviewer is the last agent. The reviewer returns a compact final handoff with satisfied ACs, Validator and Reviewer status, mandatory evidence summary, DoD status, accepted risks, durable discovery candidates, follow-ups, blockers, changed paths, and the next manual action. The orchestrator then returns:

```text
Status: NEEDS_APPROVAL
Current phase: developer-completion
Current slice: SL-###
Next agent: none
Reason: Validator and Reviewer passed; manual spec workspace update is required.
Next action: Developer reviews evidence and applies the Developer Completion Protocol.
```

To complete the slice manually, the developer confirms Validator `PASS`, Reviewer `PASS`, mandatory evidence, satisfied ACs, and applicable DoD; then marks the slice `done`, fills compact `completion_summary`, records relevant accepted risks and durable discoveries, updates traceability, QA, resume notes, and compact index metadata, and creates only truly necessary follow-up slices. The developer must not change acceptance criteria to hide implementation drift. If an AC, requirement, or scope must change, do not complete the slice; return to `MODE=RESUME`.

The spec-state atomicity guarantee is only that the spec does not advance automatically during execution. It is not a filesystem transaction. Partial code may remain in the working tree for correction, but partial work is never recorded as a completed slice. An interruption during manual completion requires checking the compact index, current slice, traceability, QA, and resume notes for consistency before another slice starts; restore consistency directly or use `MODE=RESUME`.

## Human gates

The developer must approve `plan-execution.md` before test planning and approve `test-plan.md` before coding. Creating or changing either contract repeats its gate. Scope changes, new allowed paths, meaningful dependencies, and major architecture decisions also require explicit developer approval.

Before routing a phase, confirm the current phase, current slice, required artifact availability, approval state, and scoped paths. If any authority or eligibility is unclear, stop with `BLOCKED` or `NEEDS_APPROVAL`.

## Subagent policy

Only `sentinel-orchestrator` may spawn or delegate to another Sentinel agent, and only to the next eligible role in the fixed workflow. Non-orchestrator Sentinel agents must not spawn subagents. They return a short handoff to the orchestrator; the developer and orchestrator control transitions.

The intended chain is:

```text
root/developer -> sentinel-orchestrator -> selected Sentinel agent
```

Do not create recursive agent chains or uncontrolled fan-out.

## Skills

Load a skill only when the current slice package, approved plan, test plan, diff, sensitive area, or specific validation rule directly requires it. Never load a skill just in case. Orchestrator loads no technical skills.

| Agent | .NET | Node/TS | Frontend | Testing | DB/Migrations | Security/Auth |
|---|---:|---:|---:|---:|---:|---:|
| orchestrator | No | No | No | No | No | No |
| planner | Yes | Yes | Yes | Yes | Yes | Yes |
| test-planner | Yes | Yes | Yes | Yes | Yes | Yes |
| coder | Yes | Yes | Yes | Yes | Restricted | Restricted |
| validator | Yes | Yes | Yes | Yes | Restricted | Restricted |
| reviewer | Yes | Yes | Yes | Yes | Yes | Yes |

For coder and validator, database/migration and security/auth skills require explicit relevance and plan authorization.

## Handoffs

Handoffs are short, textual, disposable, and non-persistent. Use only `PASS`, `BLOCKED`, `NEEDS_APPROVAL`, `NEEDS_FIX`, `NEEDS_REPLAN`, or `NEEDS_RETEST_PLAN`.

```text
Status:
Current phase:
Current slice:
Next agent:
Reason:

Relevant scope:
Allowed paths:
Read paths:
Blocked paths:

Evidence:
Issues:
Next action:
```

Do not repeat full contracts, paste full diffs or long logs, or store operational history.

## Return routing

- Local implementation defect: validator/reviewer -> coder.
- Plan defect or incompatible plan: coder/validator/reviewer -> planner -> renewed developer approval.
- Evidence-contract or test-strategy defect: coder/validator/reviewer -> test-planner -> renewed developer approval.
- Reviewer `PASS`: orchestrator -> developer completion with `NEEDS_APPROVAL` and no next agent.
- Scope change: `BLOCKED` pending developer decision.

All routing goes through the orchestrator.

## Recovery after interruption

After network failure, lost session, crash, or partial implementation:

1. Read compact `feature_spec.md` index or `spec.md`.
2. Read the current `slices/SL-###.md` and linked shared artifact blocks only.
3. Read `lifecycle/traceability.md`, `lifecycle/qa-checklist.md`, and `lifecycle/resume-notes.md` when checking continuity or possible manual completion drift.
4. Read `plan-execution.md`.
5. Read `test-plan.md`.
6. Focus only on the target slice.
7. Inspect only its partial diff.
8. Detect whether a manual spec update is partial or inconsistent.
9. Continue, clean up, block, or restore consistency directly or through `MODE=RESUME`.

Do not trust stale conversation blindly. Approved contracts are reusable; partial implementation attempts are disposable when they lose reliability.
