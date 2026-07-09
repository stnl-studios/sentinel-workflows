---
name: stnl-spec-execution-manager
description: Use to conservatively plan, execute, validate, correct, and close delivery work from a clear requirements document while preserving scope and evidence boundaries.
---

# stnl-spec-execution-manager

## Purpose

Manage an optional delivery workflow from a sufficiently clear requirements source:

```text
requirements source
→ plan
→ self-critique
→ tasks
→ phase delivery
→ tests
→ validation
→ correction
→ revalidation
→ conclusion
→ operational closure
```

The input can be a `feature_spec.md` produced by any process or any other clear requirements document. This skill does not require a particular SPEC skill, vendor, model, agent topology, or commit policy.

It preserves requirements authority. If delivery work exposes an ambiguity, requirement conflict, scope change, or material strategy decision that the source does not authorize, stop the affected work, record the divergence, and return it to the owner of the requirements process. Do not solve a requirements problem by silently changing tasks or implementation.

## Inputs and workspace selection

Accept a requirements path, an optional execution root, an optional requested phase, and user-supplied operational constraints. Preserve the source document exactly where it is. When the source is `feature_spec.md`, default the execution root to `<spec-root>/execution/`. For another source without its own execution workspace, use a sibling `<requirements-name>-execution/` workspace. Record the explicit relative source path in `plan.md` and each detailed plan.

The common colocated layout is:

```text
<spec-workspace>/
├── feature_spec.md
├── shared/
└── execution/
    ├── plan.md
    ├── plans/
    │   ├── plan-01.md
    │   ├── plan-02.md
    │   └── ...
    ├── tasks.md
    └── tasks/
        ├── tasks-01.md
        ├── tasks-02.md
        └── ...
```

Do not rename, move, or copy an external source merely to fit this layout. `plan.md` is the compact authority for the chosen execution workspace and records `requirements_source` as an explicit relative path. Execution artifacts never belong to the requirements source's documentary workspace.

## Operational contracts

1. `plan.md` is a compact cumulative index. Every foreseeable phase has one `[ ]` or `[x]` row and a detailed file in `plans/`.
2. `plans/plan-NN.md` defines one observable delivery, its requirements references, boundaries, likely areas, dependencies, risks, strategy, expected tests or validation, and ready criterion. Likely areas guide discovery, not an absolute allowlist; record and assess any expansion. It never becomes a microtask checklist.
3. `tasks.md` is a compact cumulative index. It does not discard earlier work or duplicate detailed task content.
4. `tasks/tasks-NN.md` records one detailed checklist, expected and actual areas, acceptance per task, tests, findings, corrections, revalidation, diff summary, and result.
5. A phase has only `[ ]` or `[x]`. Tasks may be completed earlier; the phase is `[x]` only after mandatory tasks, relevant tests, and finalization following independent validation. Focused revalidation must also pass when initial validation returned `NEEDS_FIX`; otherwise finalization records it as `not_required`.
6. A completed phase is immutable. Later work becomes a new corrective or complementary phase.
7. Validation returns exactly `PASS` or `NEEDS_FIX`, changes no code, records its verdict and findings in the selected phase artifact, and does not accept the executor's self-declaration as proof.
8. Parallel delivery is permitted only after the explicit non-overlap check. Workers update only their own detailed task files; a coordinator serializes index changes.

## Workflow

### Plan

Read the requirements source and only relevant code. Create the compact plan index and all foreseeable detailed plans. Do not create task indices or detailed task files.

### Plan review

Self-critique the plan for phase sizing, dependencies, requirements coverage, migrations, external dependencies, breaking changes, shared files and state, testability, order, assumptions, and parallel safety. Correct the plan directly; do not create tasks.

### Task materialization

From the approved plan, create the compact tasks index and materialize only `tasks/tasks-01.md` or the next executable detailed task file.

### Phase delivery

Read the requirements source, selected detailed plan, selected detailed tasks, linked records, and related code. Implement the selected scope, run relevant tests, complete individual tasks, and record concise evidence. Do not complete the phase index row.

### Validation, correction, and conclusion

An independent validator compares the diff, selected plan, tasks, requirements, and test record without changing code, detailed evidence, or compact indices. `NEEDS_FIX` findings state problem, evidence, impact, reference, and expected correction. Finalization processes the persisted verdict: an initial `PASS` records `revalidation: not_required`, finalizes the detailed record, and updates both compact indices; `NEEDS_FIX` permits only its findings and necessary effects to be corrected, retested, recorded, and independently revalidated. A material requirements or strategy change blocks delivery. After revalidation `PASS`, finalization updates both compact indices; materialize later tasks only in a separate task-materialization operation.

### Operational closure

Cross-check requirements, indices, detailed records, code, tests, findings, and evidence. Do not rely only on checkboxes. Use an explicit policy:

- `consolidate_and_remove`: incorporate only durable user-requested facts into the requirements source when appropriate, then remove delivery artifacts.
- `consolidate_and_keep`: incorporate allowed durable facts and retain delivery artifacts.
- `validate_only`: report compatibility and retain all inputs unchanged.

The default policy is decided by the caller; the skill never requires destructive consolidation.

## File Purpose Header

Every applicable delivery artifact, template, reference, example, and eval starts with `# File Purpose Header`, followed by one YAML block containing exactly: `purpose`, `status`, `read_when`, `do_not_read_when`, `contains`, `owner`, and `update_policy`.

Use only `draft`, `ready`, `blocked`, `done`, `closed`, or `not_applicable` for header status. Keep headers concise and selective-reading oriented; never put a delivery phase state in the header.

## Lazy-loading map

| Operation | Read |
|---|---|
| Initial planning | `references/workspace.md`, `phase-model.md`, `phase-execution-contract.md`, `token-economy.md`, source requirements, and relevant code |
| Deliver one phase | source requirements, selected `plans/plan-NN.md`, selected `tasks/tasks-NN.md`, linked records, and related code |
| Validate one phase | source requirements, selected plan and tasks, phase diff, and test record |
| Correct and conclude | selected findings, selected task file, affected code, and related tests |
| Operational closure | `execution-close-policy.md`, compact indices, and only details needed to resolve coverage gaps |

Load examples only to clarify format. Do not load all plans, all task files, all requirements records, or the whole repository by default.

## Evaluation

Read `references/eval-guidance.md` and use `evals/eval-plan.md` when changing this skill. Validate phase boundaries, requirement preservation, selective reads, independent validation, safe parallelization, closure policies, headers, and no mandatory vendor or model.
