# Sentinel Workflows Basic for Codex

Sentinel Workflows Basic is a contract-driven workflow for executing approved feature slices with explicit human gates, bounded paths, objective evidence, and disposable handoffs. The functional spec, approved technical plan, and approved test plan are the authorities for execution. Free conversation alone never authorizes a phase.

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
  -> finalizer
```

The spec is the functional contract. The approved plan is the technical contract. The approved test plan is the evidence contract. The coder executes only approved slices. Validator and reviewer do not edit code. Any scope, plan, test, dependency, or architecture change returns to developer approval.

## Persistent artifacts and authority

| Artifact | Exclusive write authority |
|---|---|
| `feature_spec.md` | `stnl-spec-lifecycle-manager` only |
| `spec.md` | lifecycle/spec management only |
| `plan-execution.md` | planner only |
| `test-plan.md` | test-planner only |
| `spec-close-inputs.md` | finalizer only |

The finalizer writes only `spec-close-inputs.md`. It never edits `feature_spec.md` or `spec.md`, invokes lifecycle `MODE=CLOSE`, or closes the spec. Close ownership remains:

```text
finalizer -> spec-close-inputs.md
stnl-spec-lifecycle-manager / MODE=CLOSE -> feature_spec.md
```

`spec-close-inputs.md` is lifecycle input, not an automatic close report. Never create `final.md`, persistent handoff files, or operational-history artifacts.

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

Load a skill only when the current slice, approved plan, test plan, diff, sensitive area, or specific validation rule directly requires it. Never load a skill just in case. Orchestrator and finalizer load no technical skills.

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

1. Read `feature_spec.md` or `spec.md`.
2. Read `plan-execution.md`.
3. Read `test-plan.md`.
4. Read `spec-close-inputs.md` if it exists.
5. Focus only on the target slice.
6. Inspect only its partial diff.
7. Decide whether the partial implementation is trustworthy.
8. Continue, clean up, or block.

Do not trust stale conversation blindly. Approved contracts are reusable; partial implementation attempts are disposable when they lose reliability.
