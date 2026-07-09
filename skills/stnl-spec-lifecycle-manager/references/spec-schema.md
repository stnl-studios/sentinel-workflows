# File Purpose Header

```yaml
purpose: Define active and closed feature SPEC shapes and shared artifact fields.
status: not_applicable
read_when: Creating, resuming, reviewing, or closing a SPEC artifact.
do_not_read_when: Only a lifecycle rule without file construction is needed.
contains: Required sections, artifact fields, selective-reading guidance, and closed content.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with the workspace and lifecycle policy.
```

# SPEC Schema

## Active feature SPEC

`feature_spec.md` contains File Purpose Header; SPEC metadata; objective; context; scope; out of scope when relevant; requirements; business rules; relevant contracts; canonical artifact index; blockers; and selective-reading instructions. It may summarize an artifact but does not duplicate its full canonical block.

Suggested metadata:

```yaml
spec_id: <feature-slug>
workspace_root: specs/<feature-slug>
spec_status: draft | ready | blocked
created_from_mode: INIT
last_updated_mode: INIT | RESUME
open_question_count: 0
```

Each materialized category declares its file, count, and materialization state. The artifact index is a discovery aid, not a second authority.

## Shared artifacts

Every item has a heading and YAML `id:`. Use only category fields that add meaning: a criterion statement, a decision and impact, a constraint and reason, a risk and mitigation, or a question and resolution. Cross-references use canonical IDs.

## Closed feature SPEC

After CLOSE, `feature_spec.md` contains File Purpose Header; objective; needed context; final scope; out of scope; requirements; business rules; final acceptance criteria; durable decisions; relevant constraints; relevant risks; important contracts; and resolved questions with durable value.
