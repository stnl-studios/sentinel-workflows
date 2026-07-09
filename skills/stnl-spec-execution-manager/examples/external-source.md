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
└── billing-change-delivery/
    ├── plan.md
    ├── plans/plan-01.md
    ├── tasks.md
    └── tasks/tasks-01.md
```

`billing-change.md` remains unchanged. The plan index and detailed plan both state `requirements_source: ../billing-change.md`, so every delivery record has an explicit authority path without renaming or copying the source.
