# File Purpose Header

```yaml
purpose: Show a ready delivery workspace with compact indices, all plans, and one detailed task record.
status: ready
read_when: A concrete phase-driven delivery layout is needed.
do_not_read_when: Only an external-source or closure policy example is needed.
contains: Tree and compact examples of indices and detailed phase records.
owner: stnl-spec-execution-manager
update_policy: Keep aligned with the workspace, phase model, and templates.
```

# Phase-Driven Workspace

```text
specs/invitation-expiration/
├── feature_spec.md
├── shared/
│   ├── acceptance-criteria.md
│   ├── constraints.md
│   └── risks.md
├── plan.md
├── plans/
│   ├── plan-01.md
│   └── plan-02.md
├── tasks.md
└── tasks/
    └── tasks-01.md
```

`plan.md` has compact rows only:

| Done | Phase | Objective | Dependencies | Covered IDs or criteria | Parallel | Detail | Result |
|---|---|---|---|---|---|---|---|
| [ ] | 01 - Expire invitations | Reject expired invitations | - | AC-001, C-001, R-001 | no | plans/plan-01.md | - |
| [ ] | 02 - Expose state | Show expiration state in lookup | 01 | AC-002, C-001 | no | plans/plan-02.md | - |

`tasks.md` contains only phase 01 because phase 02 cannot begin until phase 01 concludes. `plans/plan-01.md` references source records without copying them. `tasks/tasks-01.md` contains local tasks `1.1` and `1.2`, expected tests, and pending evidence.
