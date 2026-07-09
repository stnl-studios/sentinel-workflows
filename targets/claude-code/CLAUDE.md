# Sentinel Workflows Basic for Claude Code

Sentinel Workflows Basic is a contract-driven workflow for executing approved feature slices with explicit human gates, bounded paths, objective evidence, and disposable handoffs. The spec slice package, approved technical plan, and approved test plan are the authorities for execution. Free conversation alone never authorizes a phase.

## Target layout

- `CLAUDE.md`: project guidance for the Claude Code target.
- `.claude/settings.json`: conservative project-level Claude Code settings.
- `.claude/agents/*.md`: project-scoped Sentinel subagents.
- `.claude/skills/*/SKILL.md`: progressively loaded technical skills.

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
  -> finalizer
```

The spec workspace is modular. Operational `feature_spec.md` is a compact index; the orchestrator prepares the current slice package from `feature_spec.md`, `slices/SL-###.md`, and linked shared artifacts. The approved plan is the technical contract. The approved test plan is the evidence contract. The coder executes only approved slices. Validator and reviewer do not edit code. Any scope, plan, test, dependency, or architecture change returns to developer approval.

## Persistent artifacts and authority

| Artifact | Exclusive write authority |
|---|---|
| operational `feature_spec.md` index | lifecycle/spec management and finalizer compact metadata only |
| `shared/acceptance-criteria.md` | lifecycle/spec management only |
| `shared/decisions.md`, `shared/constraints.md`, `shared/risks.md` | lifecycle/spec management; finalizer may append durable artifacts |
| `shared/questions.md` | lifecycle/spec management only |
| `slices/SL-###.md` | lifecycle/spec management; finalizer may mark the completed slice done and create necessary follow-up slices |
| `lifecycle/traceability.md`, `lifecycle/qa-checklist.md`, `lifecycle/resume-notes.md` | lifecycle/spec management; finalizer may update after a successful round |
| `spec.md` | lifecycle/spec management only |
| `plan-execution.md` | planner only |
| `test-plan.md` | test-planner only |

The finalizer applies one atomic modular spec update only after validator and reviewer both pass. It never changes acceptance criteria to hide requirement drift, invokes lifecycle `MODE=CLOSE`, removes operational directories, or closes the spec. `MODE=CLOSE` alone compacts the workspace into the final one-file `feature_spec.md`.

Never create `final.md`, close-input files, persistent handoff files, slice context package files, or operational-history artifacts.

## Human gates

The developer must approve `plan-execution.md` before test planning and approve `test-plan.md` before coding. Creating or changing either contract repeats its gate. Scope changes, new allowed paths, meaningful dependencies, and major architecture decisions also require explicit developer approval.

Before routing a phase, confirm the current phase, current slice, required artifact availability, approval state, and scoped paths. If any authority or eligibility is unclear, stop with `BLOCKED` or `NEEDS_APPROVAL`.

## Subagent policy

Only `sentinel-orchestrator` has the `Agent` tool and may delegate to another Sentinel subagent, and only to the next eligible role in the fixed workflow. Non-orchestrator Sentinel subagents must not invoke `Agent` or create subagent chains. They return a short handoff to the orchestrator; the developer and orchestrator control transitions.

The intended chain is:

```text
root/developer -> sentinel-orchestrator -> selected Sentinel subagent
```

Do not create recursive agent chains or uncontrolled fan-out.

## Tool hardening

Every Sentinel subagent declares an explicit `tools` allowlist in its frontmatter. Never remove or broaden it:

| Subagent | tools |
|---|---|
| `sentinel-orchestrator` | `Read, Glob, Agent` |
| `sentinel-planner` | `Read, Glob, Grep, Write, Edit` |
| `sentinel-test-planner` | `Read, Glob, Grep, Write, Edit` |
| `sentinel-coder` | `Read, Write, Edit, MultiEdit, Bash` |
| `sentinel-validator` | `Read, Bash` |
| `sentinel-reviewer` | `Read, Glob, Grep` |
| `sentinel-finalizer` | `Read, Write, Edit` |

The coder has no `Glob`/`Grep` by design: the approved plan must give it specific allowed and read paths so it never needs to explore. Subagent boundaries are enforced by frontmatter, not by `settings.json` alone.

## Skills

Load a skill only when the current slice package, approved plan, test plan, diff, sensitive area, or specific validation rule directly requires it. Never load a skill just in case. Orchestrator and finalizer load no technical skills.

| Agent | .NET | Node/TS | Frontend | Testing | DB/Migrations | Security/Auth |
|---|---:|---:|---:|---:|---:|---:|
| orchestrator | No | No | No | No | No | No |
| planner | Yes | Yes | Yes | Yes | Yes | Yes |
| test-planner | Yes | Yes | Yes | Yes | Yes | Yes |
| coder | Yes | Yes | Yes | Yes | Restricted | Restricted |
| validator | Yes | Yes | Yes | Yes | Restricted | Restricted |
| reviewer | Yes | Yes | Yes | Yes | Yes | Yes |
| finalizer | No | No | No | No | No | No |

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
- Scope change: `BLOCKED` pending developer decision.
- Incomplete DoD or evidence at finalization: `BLOCKED` or return to the responsible role.

All routing goes through the orchestrator.

## Recovery after interruption

After network failure, lost session, crash, or partial implementation:

1. Read compact `feature_spec.md` index or `spec.md`.
2. Read the current `slices/SL-###.md` and linked shared artifact blocks only.
3. Read `plan-execution.md`.
4. Read `test-plan.md`.
5. Focus only on the target slice.
6. Inspect only its partial diff.
7. Decide whether the partial implementation is trustworthy.
8. Continue, clean up, or block.

Do not trust stale conversation blindly. Approved contracts are reusable; partial implementation attempts are disposable when they lose reliability.
