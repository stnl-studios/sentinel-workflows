# File Purpose Header

```yaml
purpose: Prompt template for resolving or revising an existing feature SPEC.
status: ready
read_when: A user needs MODE RESUME.
do_not_read_when: A new SPEC, documentary review, or closure is requested.
contains: Resume input slots and preservation boundaries.
owner: stnl-spec-lifecycle-manager
update_policy: Update when RESUME behavior changes.
```

Use stnl-spec-lifecycle-manager.
MODE=RESUME

SPEC path: <feature_spec.md or workspace>
New fact or requested change: <answer, decision, inconsistency, scope delta, or correction>
Preserve: <IDs, decisions, constraints, or other durable records>

Read only affected artifacts. Incorporate explicit answers, decisions, and documentary corrections; preserve IDs; update references consistently; and make material changes visible. Do not erase relevant decision history or create delivery artifacts.
