# File Purpose Header

```yaml
purpose: Define the modular SPEC workspace, file responsibilities, and selective reads.
status: not_applicable
read_when: Creating, resuming, reviewing, or closing a feature SPEC workspace.
do_not_read_when: Only one canonical artifact format is needed.
contains: Workspace tree, file boundaries, materialization rules, and selective reading.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when the SPEC workspace architecture changes.
```

# SPEC Workspace

Default to `specs/<feature-slug>/` when the consumer provides no stronger convention.

```text
specs/<feature-slug>/
├── feature_spec.md
└── shared/
    ├── acceptance-criteria.md
    ├── decisions.md
    ├── constraints.md
    ├── risks.md
    └── questions.md
```

Shared files are optional and exist only for materialized categories. A blocked SPEC may contain only `feature_spec.md` and `shared/questions.md`. Do not create empty categories merely to complete the tree.

## Responsibilities

- `feature_spec.md`: documentary authority for purpose, context, scope, requirements, rules, contracts, artifact discovery, blockers, and selective reading.
- `shared/*.md`: one canonical category per file, used only where a full canonical record is needed.

## Selective reading

- INIT: user input, existing requirements material, and only directly relevant conventions.
- RESUME: `feature_spec.md`, the affected shared category, and records named by canonical ID.
- PLANNING: `feature_spec.md` and only shared artifacts needed to assess a stated concern.
- CLOSE: begin with `feature_spec.md`, then read only materialized artifacts necessary to consolidate durable content.

Do not create permanent context packages, histories, or duplicated matrices. A separate delivery workflow may consume this workspace, but it is not part of this skill.
