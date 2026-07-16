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
5. Follow its required `verifies: [R-002]` link to that exact requirement. If its metadata also has `references: [D-001, C-001]`, open only those exact records as needed.
6. If the active AC has `blocked_by: [Q-001]`, open that question, confirm it is `open` and `classification: blocking`, then confirm the inverse `Q-001.blocks` relationship.
7. Stop; do not load unrelated requirements, risks, questions, decisions, constraints, or full shared files.

Discovery comes from the feature index; traversal comes only from `verifies`, `blocks`, `blocked_by`, `linked_decision`, and `references`, without a synthetic linkage section.
