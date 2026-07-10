# File Purpose Header

```yaml
purpose: Demonstrate exact selective reading for one canonical ID.
status: ready
read_when: A maintainer needs a localized lookup without loading the whole workspace.
do_not_read_when: The task is workspace creation or full final consolidation.
contains: One-ID read sequence, item boundary, and structural-link traversal.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with workspace authority, item grammar, and token economy.
```

# Selective Reading of `AC-002`

1. Read only the File Purpose Header and Canonical Artifact Index of `feature_spec.md`.
2. Map `AC-*` to `shared/acceptance-criteria.md`.
3. Open that one file and locate the exact heading `### AC-002 — ...`.
4. Read from that heading through the next `###` heading or EOF.
5. If its metadata is `references: [D-001, C-001]`, open only those exact records as needed. If an active AC has `blocked_by: [Q-001]`, open that question too and confirm it is still `open`.
6. Confirm the inverse `Q-001.blocks` relationship if blocking is relevant to the question being answered.
7. Stop; do not load unrelated risks, questions, decisions, constraints, or full shared files.

Discovery comes from the feature index; traversal comes only from `blocks`, `blocked_by`, `linked_decision`, and `references`, without a synthetic linkage section.
