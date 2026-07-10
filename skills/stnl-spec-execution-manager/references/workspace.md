# File Purpose Header

```yaml
purpose: Define slice execution workspace selection, source preservation, relative paths, and artifact responsibilities.
status: not_applicable
read_when: Selecting an execution root or creating slice execution artifacts.
do_not_read_when: A selected detailed artifact already provides the needed local context.
contains: Standard layout, external-source handling, relative path rule, file boundaries, and source references.
owner: stnl-spec-execution-manager
update_policy: Change only when the execution workspace architecture changes.
```

# Execution Workspace

Prefer a dedicated execution root. If the source is `feature_spec.md` in a dedicated requirements workspace, default to its `execution/` child without modifying the source document or its `shared/` records. If the source has another name or location, preserve it and default to a sibling `<requirements-name>-execution/` root.

```text
<execution-root>/
├── plan.md
├── plans/
│   ├── slice-01.md
│   └── ...
├── tasks.md
└── tasks/
    ├── slice-01.md
    └── ...
```

## Relative Paths

Every persisted path is relative to the file that contains it.

- In `execution/plan.md`, a colocated source can be `../feature_spec.md`.
- In `execution/plans/slice-01.md`, the same source can be `../../feature_spec.md`.
- In `execution/tasks/slice-01.md`, the detailed plan must be `../plans/slice-01.md`.
- In `execution/tasks/slice-01.md`, the same source can be `../../feature_spec.md`.

Do not store absolute paths unless the caller explicitly requires a non-portable workspace.

## Responsibilities

- `plan.md`: compact global context, slice order, dependency map, per-slice summaries, coverage references, likely areas, parallel notes, and detailed plan paths. It is not progress state.
- `plans/slice-NN.md`: detailed design for one observable delivery slice, not a checklist.
- `tasks.md`: compact global operational progress and the canonical `[ ]` or `[x]` row for each slice.
- `tasks/slice-NN.md`: detailed checklist and evidence record for one slice.

The source remains authoritative for requirements. Reference requirements by stable IDs or exact locations; do not copy full criteria into every execution artifact. Likely areas guide exploration but are not an absolute allowlist. Record and assess discovered expansion before acting, and block when it changes authorized requirements, scope, dependencies, or strategy.
