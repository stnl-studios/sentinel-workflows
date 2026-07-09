# File Purpose Header

```yaml
purpose: Define delivery workspace selection, source preservation, and artifact responsibilities.
status: not_applicable
read_when: Selecting an execution location or creating delivery artifacts.
do_not_read_when: A known detailed artifact already provides the needed local context.
contains: Colocated layout, external-source handling, file boundaries, and source references.
owner: stnl-spec-execution-manager
update_policy: Change only when the delivery workspace architecture changes.
```

# Delivery Workspace

Prefer a safe location adjacent to the requirements source. If the source is `feature_spec.md` in a dedicated workspace, use that workspace without modifying the requirements document. If the source has another name or is external, preserve it and choose a documented adjacent execution location. Every index and detailed plan names the source path explicitly.

```text
<execution-workspace>/
├── <requirements source, preserved when colocated>
├── plan.md
├── plans/
│   ├── plan-01.md
│   └── ...
├── tasks.md
└── tasks/
    ├── tasks-01.md
    └── ...
```

## Responsibilities

- `plan.md`: all phase rows, order, dependencies, coverage references, parallel notes, detailed paths, and short completion results.
- `plans/plan-NN.md`: detailed delivery design for one phase, not a task list.
- `tasks.md`: compact cumulative task evidence index.
- `tasks/tasks-NN.md`: detailed execution record for one phase.

The source remains authoritative for requirements. A linked requirements record may be read selectively; it is not copied into every plan or task document. Likely areas in a detailed plan are guidance, not an absolute allowlist. Record and assess any discovered expansion; stop when it changes authorized requirements, scope, dependencies, or strategy.
