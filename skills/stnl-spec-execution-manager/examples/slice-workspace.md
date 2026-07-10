# File Purpose Header

```yaml
purpose: Show a complete slice execution workspace with useful global summaries and all task files materialized.
status: ready
read_when: A concrete slice-based execution layout or progress example is needed.
do_not_read_when: Only an external-source, validation, or parallelization example is needed.
contains: Tree, compact plan context, tasks progress with first slice concluded, and three detailed slice paths.
owner: stnl-spec-execution-manager
update_policy: Keep aligned with the workspace, slice model, and templates.
```

# Slice Execution Workspace

```text
specs/invitation-expiration/
├── feature_spec.md
├── shared/
│   ├── acceptance-criteria.md
│   ├── constraints.md
│   └── risks.md
└── execution/
    ├── plan.md
    ├── plans/
    │   ├── slice-01.md
    │   ├── slice-02.md
    │   └── slice-03.md
    ├── tasks.md
    └── tasks/
        ├── slice-01.md
        ├── slice-02.md
        └── slice-03.md
```

`execution/plan.md` records `requirements_source: ../feature_spec.md` and compact context:

| Slice | Summary | Dependencies | Covered Requirements | Expected Areas | Parallelization | Detailed Plan |
|---|---|---|---|---|---|---|
| 01 - Expiration domain | Persist invitation expiration and reject expired acceptance | - | AC-001, C-001, R-001 | `src/invitations/domain`, domain tests | no: foundational state | plans/slice-01.md |
| 02 - Lookup state | Expose expiration state in invitation lookup responses | 01 | AC-002, C-001 | `src/invitations/api`, API tests | no: depends on slice 01 fields | plans/slice-02.md |
| 03 - Cleanup command | Add a maintenance command to mark stale pending invitations | 01 | AC-003, R-002 | `src/invitations/jobs`, job tests | no: shares invitation state with slice 02 | plans/slice-03.md |

Each summary is enough for orientation, but details stay in the slice plans.

`execution/tasks.md` is the only global progress authority:

| Done | Slice | Delivery | Dependencies | Detail | Tests | Validation | Result |
|---|---|---|---|---|---|---|---|
| [x] | 01 - Expiration domain | Expiration is persisted and enforced | - | tasks/slice-01.md | PASS: domain tests | PASS | Done: rejects expired invitations |
| [ ] | 02 - Lookup state | Lookup exposes expiration state | 01 | tasks/slice-02.md | pending | pending | - |
| [ ] | 03 - Cleanup command | Stale pending invitations can be marked | 01 | tasks/slice-03.md | pending | pending | - |

With slice 01 concluded, slice 02 is the current deterministic slice because it is the first open eligible row. Slice 03 is also dependency-ready only if its detailed task file has no blocking divergence; if both are intended to run together, the caller must explicitly request both.

`tasks/slice-01.md` stores the completed checklist, changed areas, test evidence, validation verdict, diff summary, and final result. `tasks/slice-02.md` and `tasks/slice-03.md` already exist from `MATERIALIZE_TASKS`, so a later clean session does not need to regenerate task files.
