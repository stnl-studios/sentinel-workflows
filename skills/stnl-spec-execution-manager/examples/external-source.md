# File Purpose Header

```yaml
purpose: Show execution artifacts beside a requirements source that is not feature_spec.md.
status: ready
read_when: The supplied requirements document uses another name or location.
do_not_read_when: A colocated feature_spec.md already defines the execution workspace.
contains: Source preservation, location choice, and explicit reference example.
owner: stnl-spec-execution-manager
update_policy: Keep aligned with workspace source-preservation rules.
```

# External Requirements Source

```text
requirements/
├── billing-change.md
└── billing-change-execution/
    ├── plan.md
    ├── plans/plan-01.md
    ├── tasks.md
    └── tasks/tasks-01.md
```

`billing-change.md` remains unchanged. The plan index states `requirements_source: ../billing-change.md`; its detailed plan and task record state `requirements_source: ../../billing-change.md`. Every delivery record has an explicit relative authority path without renaming, moving, or copying the source.
