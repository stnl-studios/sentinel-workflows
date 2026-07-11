---
name: stnl-spec-execution-manager
description: Use to plan, execute, validate, correct, finalize, and close incremental delivery slices from a clear requirements source while preserving authority, selective reading, and evidence boundaries.
---

# stnl-spec-execution-manager

## Purpose

Manage an optional delivery workflow from any sufficiently clear requirements source:

```text
requirements
-> PLAN
-> REVIEW_PLAN
-> MATERIALIZE_TASKS
-> EXECUTE_SLICE
   or PARALLELIZE_SLICES when independent slices are explicit
-> VALIDATE_SLICE
-> if NEEDS_FIX: APPLY_FINDINGS
-> if corrections were applied: VALIDATE_SLICE as revalidation
-> FINALIZE_SLICE
-> CLOSE
```

The source may be a `feature_spec.md` produced by another process or any other clear requirements document. This skill does not require a particular requirements skill, vendor, model, agent topology, context-reset command, or subagent.

Run exactly one operation per invocation. Do not silently continue into the next operation.

## Authority Boundary

The requirements source remains the product authority. This skill may plan and execute against it, but it must not:

- silently change requirements;
- reinterpret criteria to fit an implementation;
- incorporate new decisions directly into the source;
- resolve scope changes through tasks;
- edit lifecycle-owned documentary artifacts.

When execution exposes ambiguity, conflict, material scope change, new material dependency, or an unauthorized strategic decision, record the divergence concisely in the selected slice task file, block only affected work when the divergence is blocking, and report the decision needed.

## Invocation Inputs

Accept exactly one `OPERATION`, `SPEC_PATH`, and only the slice input required by that operation. The execution root is derived, never supplied as an invocation input.

- `SPEC_PATH` is normalized according to `references/workspace.md`; it determines the preserved requirements source and execution root.
- `SLICE` is required by `EXECUTE_SLICE`, `VALIDATE_SLICE`, `APPLY_FINDINGS`, and `FINALIZE_SLICE` and is normalized to `slice-NN`. Block when it is absent, even if exactly one slice is eligible.
- `SLICES` is required by `PARALLELIZE_SLICES`; it is an explicit comma-separated list normalized to distinct `slice-NN` identifiers. Block when it is absent; never infer candidates.

The optional free-text additional context is transient. It may restrict the selected operation for a concrete current circumstance, but never replaces the required selective reads, persists automatically, changes authority, or authorizes work outside that operation. If it materially conflicts with requirements or an approved plan, block the affected operation, identify the concrete artifact or ID, and direct the caller to `RESUME`, `REVIEW_PLAN`, or the applicable contractual operation. Do not silently choose a version or edit requirements to accommodate it.

## Workspace

Derive the requirements source and execution root from `SPEC_PATH` before reading operation artifacts. A directory containing `feature_spec.md` and a direct path to that file resolve to the same workspace and its `execution/` child. Another requirements file is preserved and receives the sibling root defined in `references/workspace.md`.

Standard layout:

```text
<execution-root>/
├── plan.md
├── plans/
│   ├── slice-01.md
│   ├── slice-02.md
│   └── ...
├── tasks.md
└── tasks/
    ├── slice-01.md
    ├── slice-02.md
    └── ...
```

All persisted paths are relative to the artifact that contains them. For example, `execution/plan.md` may use `../feature_spec.md`, `execution/plans/slice-01.md` may use `../../feature_spec.md`, and `execution/tasks/slice-01.md` must point to `../plans/slice-01.md`.

## Derived Operation Inputs

After normalization, derive `plan.md`, `tasks.md`, `plans/slice-NN.md`, and `tasks/slice-NN.md` from the execution root. Derive the selected slice objective and scope, dependencies, referenced requirements, persisted findings and corrections, test evidence, validation/revalidation state, and finalization criteria from those artifacts. `PARALLELIZE_SLICES` evaluates only the explicitly normalized candidates; it never discovers additional slices. Block with an objective diagnostic when a required source or operation artifact is absent.

## Artifact Contracts

- `plan.md` preserves compact global context: requirements source, overall objective, delivery strategy, slice order, dependencies, each slice summary, expected areas, coverage references, parallelization notes, and detailed plan paths. It is not a progress authority and must not duplicate completion checkboxes.
- `plans/slice-NN.md` defines one observable, testable, coherent delivery. It includes exact requirements references, included and excluded scope, boundaries with other slices, likely affected areas, dependencies, risks, strategy, expected tests, a short completion criterion, and parallelization assessment.
- `tasks.md` is the only global progress authority. It has one compact `[ ]` or `[x]` row per slice with summary, dependencies, detailed task path, test summary, validation summary, and final result.
- `tasks/slice-NN.md` is the complete operational record for one slice: plan link, numbered checklist, expected areas and acceptance per task, expected tests, actual changes, scope expansion, simple divergence record, test evidence, validation verdict and findings, corrections, revalidation, diff summary, and final result.

`[ ]` means not concluded. `[x]` means concluded. No other global slice state is required.

The execution artifacts may identify eligible slices and present the first eligible open slice only as a suggested next slice. Every slice operation requires an explicit normalized `SLICE`, including when one slice is eligible. Parallel work requires explicit normalized `SLICES`; do not infer a batch or additional candidates.

## Operations

### PLAN

Read the requirements source, required referenced records, shallow project structure, directly related code, and concrete imports or calls needed to understand likely impact. Create `plan.md` and every foreseeable `plans/slice-NN.md`. Do not create tasks and do not implement.

### REVIEW_PLAN

Read `plan.md`, relevant detailed plans, and relevant requirements references. Open code only to verify a concrete concern such as hidden dependencies, migrations, external integrations, breaking changes, shared state, architecture boundaries, or test risk. Correct the plan directly. Do not create tasks and do not implement.

### MATERIALIZE_TASKS

Read `plan.md`, all approved detailed slice plans, and only requirements excerpts needed to make acceptance objective. Create `tasks.md` and every `tasks/slice-NN.md`. Do not reread the codebase by default and do not implement.

### EXECUTE_SLICE

Start with `plan.md`, `tasks.md`, `plans/slice-NN.md`, `tasks/slice-NN.md`, and only requirements referenced by the selected slice. Then read explicitly listed files, required imports, related tests, and additional files only when a concrete need appears. Implement only the selected slice, update individual tasks and concise evidence, and do not mark the global slice row `[x]`.

### VALIDATE_SLICE

Validate independently from implementation. Read only the selected diff, `plans/slice-NN.md`, `tasks/slice-NN.md`, referenced requirements, test evidence, changed code, and dependencies needed to verify the diff. Do not correct code. Persist exactly `PASS` or `NEEDS_FIX`; each finding records problem, evidence, impact, related requirement/plan/task, and expected correction.

When `Validação: pending`, write the initial verdict to `Validação`. When `Validação: NEEDS_FIX`, corrections are recorded, and `Revalidação: pending`, write the focused verdict to `Revalidação` without overwriting the initial validation history.

### APPLY_FINDINGS

Read persisted findings, the selected task file, its plan, affected files, related tests, and directly involved requirements. Correct only reported findings and necessary effects. Rerun affected tests and record corrections. If a correction requires a material requirements, scope, dependency, or strategy change, block and record the divergence.

### FINALIZE_SLICE

Do not implement functionality. Verify checklist, tests, validation, findings, corrections, revalidation, diff summary, and absence of work belonging to other slices. If initial validation was `PASS`, record `Revalidação: not_required`. If it was `NEEDS_FIX`, require independent focused revalidation with `PASS`. Then finalize the detailed task file, mark the row `[x]` in `tasks.md`, record a short result, and stop.

### PARALLELIZE_SLICES

Evaluate explicitly named slices for independent execution. Verify dependencies, file overlap, shared state, schemas, contracts, fixtures, generated code, mutable tests, external resources, and ordering constraints. If independence is not proven, block parallelization. If permitted, each slice execution reads and writes only its own detailed task file and related implementation files; `tasks.md` updates are integrated later in a serial step. Do not require a particular agent topology.

### CLOSE

Cross-check requirements, `plan.md`, `tasks.md`, detailed plans, detailed task files, code, tests, findings, and evidence. Do not trust checkboxes alone. `CLOSE` intentionally validates and reports only: it returns status, inconsistencies, incomplete slices, blocking divergences, blocking findings, and evidence gaps. It must not modify the requirements source, lifecycle-owned artifacts, execution artifacts, code, or files, and it has no retention, removal, or cleanup policy.

## File Purpose Header

Every applicable execution reference, template, example, and eval starts with `# File Purpose Header`, followed by one YAML block containing exactly: `purpose`, `status`, `read_when`, `do_not_read_when`, `contains`, `owner`, and `update_policy`.

Use only `draft`, `ready`, `blocked`, `done`, `closed`, or `not_applicable` for header status. Header status describes the artifact, never slice progress.

## Lazy Loading

| Operation | Read |
|---|---|
| `PLAN` | `references/workspace.md`, `slice-model.md`, `token-economy.md`, requirements, and progressively discovered code |
| `REVIEW_PLAN` | `plan.md`, relevant `plans/slice-NN.md`, relevant requirements, and code only for concrete risks |
| `MATERIALIZE_TASKS` | `plan.md`, all `plans/slice-NN.md`, and only necessary requirement excerpts |
| `EXECUTE_SLICE` | `plan.md`, `tasks.md`, selected plan, selected task file, referenced requirements, and related code/tests |
| `VALIDATE_SLICE` | selected diff, selected plan/task files, referenced requirements, test evidence, and changed code |
| `APPLY_FINDINGS` | persisted findings, selected task file, affected code, related tests, and directly involved requirements |
| `FINALIZE_SLICE` | selected task file, `tasks.md`, selected plan, evidence, and final diff summary |
| `PARALLELIZE_SLICES` | `plan.md`, `tasks.md`, selected plans, selected task files, and concrete overlap evidence |
| `CLOSE` | `execution-close-policy.md`, global artifacts, and only details required for cross-checking |

Load examples only to clarify format. Do not load all detailed plans, all detailed task files, all requirements records, previous session history, or the whole repository by default.

## Evaluation

When changing this skill, read `references/eval-guidance.md` and use `evals/eval-plan.md`. Validate slice boundaries, task materialization, relative paths, selective reads, independent validation, evidence quality, requirements preservation, safe parallelization, closure policy, headers, and absence of mandatory vendor or model.
