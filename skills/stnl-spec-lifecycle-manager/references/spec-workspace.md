# File Purpose Header

```yaml
purpose: Define the modular SPEC workspace, artifact boundaries, and exact selective-reading procedure.
status: not_applicable
read_when: Creating, resuming, reviewing, selectively reading, or closing a feature SPEC workspace.
do_not_read_when: Only one already-located canonical item needs interpretation.
contains: Workspace tree, authorities, materialization rules, external boundary, and selective reads.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when the documentary workspace architecture changes.
```

# SPEC Workspace

Default to `specs/<feature-slug>/` when the consumer provides no stronger convention.

```text
specs/<feature-slug>/
├── feature_spec.md
├── shared/ (only when at least one category is materialized)
│   └── questions.md
└── execution/ (outside lifecycle ownership, when present)
```

Shared files are optional and exist only for materialized categories. A newly initialized draft may use `artifacts: {}` and no `shared/` directory. A blocked SPEC may contain only `feature_spec.md` and `shared/questions.md`. Never create an empty category. `execution/` and every other external directory are outside lifecycle ownership and remain unmodified, including during CLOSE.

## Authorities

- Documentary status: `status` in the File Purpose Header of `feature_spec.md`.
- Open questions: `Q-*` items whose metadata has `status: open`.
- Existing IDs: canonical `### ID — Title` headings.
- Existing files: the filesystem.
- Artifact and blocker blocks: compact derived discovery indexes, never competing authorities.

## Selective reading

For one localized concern:

1. Read the File Purpose Header and Canonical Artifact Index in `feature_spec.md`.
2. Identify the category from the requested canonical ID.
3. Open only the indexed file for that category.
4. Locate the exact `### ID — Title` heading.
5. Read through the next `###` heading or end of file.
6. Follow only the necessary `blocks`, `blocked_by`, `linked_decision`, and `references` links.

Do not require a full read of every shared file or persist synthetic linkage sections, context packages, histories, matrices, or duplicate summaries.

MODE-specific starting sets remain narrow: INIT reads supplied requirements and conventions; RESUME reads the feature index plus affected records; PLANNING reads only records needed for the stated review; CLOSE reads all materialized content necessary for safe consolidation.
