# File Purpose Header

```yaml
purpose: Describe editable Plan and Tasks and explicit exact-byte approval.
status: not_applicable
read_when: Authoring or reviewing the public preparation workflow.
do_not_read_when: Only consuming already activated execution.
contains: Draft capture, human approval, independent review and stale-byte rejection.
owner: stnl-execution-planner
update_policy: Update with the preparation approval contract.
```

# Editable Plan and Tasks

## Editable draft and explicit approval (public workflow)

Plan and Tasks must be visible together beside SPEC before independent review. The isolated registered candidate is a technical capture, not the user's editable source. Never use execution/ for an unapproved draft. Neither a draft, capture, user approval nor a reviewer decision alone grants execution authority.

1. Allocate the registered candidate with prepare-task-candidate.mjs. Run `preparation-draft.mjs create --spec-path SPEC --candidate-execution-root ROOT` once. It returns the single editable directory `<SPEC basename>-planning-draft-<allocation>` next to SPEC. Author plan.md, tasks.md and the plans/ and tasks/ detailed pairs there. Existing directories are not adopted or overwritten. Keep all user edits there; do not maintain competing editable copies in the technical root.
2. Finish all authored content and ready/approved carrier metadata before capture. Carrier metadata is only structural readiness, never evidence that the user or independent reviewer approved anything. Run `preparation-draft.mjs capture --spec-path SPEC --candidate-execution-root ROOT`. It prepares runtime identities, validates the complete projection and path premises, makes final canonical bytes visible in the editable directory, and writes a write-once technical snapshot. Show the complete final Plan and Tasks, snapshot path and returned captureSha256 to the user. Ask explicitly for approval of these exact bytes. Stop until that approval is given.
3. Only after the user explicitly approves that digest run `preparation-draft.mjs approve --spec-path SPEC --candidate-execution-root ROOT --approved-capture-sha256 SHA256`. Never invent user approval or run approve automatically. Approval is a recorded human decision, not a model decision. This still does not activate execution.
4. The independent reviewer runs `preparation-draft.mjs review --spec-path SPEC --candidate-execution-root ROOT`. Read the returned snapshot artifacts in full, the requirements and technical premises. The review hashes must refer to these exact snapshot bytes. Do not edit or canonicalize after capture. If any correction is needed, report it and return to authorship; an existing capture cannot be refreshed or its approval inherited.
5. Only after independent approval publish with publish-task-candidate.mjs and its exact review JSON. The public publication CLI requires explicit draft approval and rejects a changed draft, technical snapshot or stale digest. Read back official execution after confirmed publication. The visible documentary draft remains, but is not executable authority.

A failed capture/review preserves the original material. Never delete registry entries, approvals or snapshots to force reuse. Current write-once capture does not offer an automatic recapture/disposition command; report that boundary instead of claiming a corrected captured draft is approved. Both programmatic publication APIs and the CLI require the explicit exact-byte approval. A missing draft association never grants permission. Synthetic test fixtures establish their own clearly labeled fixture approval; production code has no legacy bypass.
