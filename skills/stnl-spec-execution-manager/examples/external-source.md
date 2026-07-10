# File Purpose Header

```yaml
purpose: Show slice execution artifacts beside a requirements source that is not feature_spec.md.
status: ready
read_when: The supplied requirements document uses another name or location.
do_not_read_when: A colocated feature_spec.md already defines the execution workspace.
contains: Source preservation, execution-root location choice, and explicit relative references.
owner: stnl-spec-execution-manager
update_policy: Keep aligned with workspace source-preservation and relative-path rules.
```

# External Requirements Source

```text
requirements/
├── billing-change.md
└── billing-change-execution/
    ├── plan.md
    ├── plans/
    │   └── slice-01.md
    ├── tasks.md
    └── tasks/
        └── slice-01.md
```

`billing-change.md` remains unchanged. The global plan states `requirements_source: ../billing-change.md`; `plans/slice-01.md` and `tasks/slice-01.md` state `requirements_source: ../../billing-change.md`. The task file points to `plan: ../plans/slice-01.md`.

Execution artifacts do not rename, move, copy, or add headers to the external source.
