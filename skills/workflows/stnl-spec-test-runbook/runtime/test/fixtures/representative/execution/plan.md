# File Purpose Header

```yaml
purpose: Global invitation execution plan.
status: ready
read_when: Preparing the initial invitation execution image.
do_not_read_when: Another delivery is selected.
contains: Current authority and initial delivery carriers.
owner: stnl-execution-planner
update_policy: Author writes; reviewer approves the final bytes.
```

# Execution Plan

## Global Context

- Requirements source: `../feature_spec.md`
- Requirements authority: sha256:11aba916db71705bfb2f518aac2b8f808c5f410559b1693949764b318b0f6424
- Plan revision: 1
- Objective: Ship invitation.
- Strategy: Two deliveries.
- Review state: approved

## Serial Slice Order

| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |
|---|---|---|---|---|---|
| 01 - Foundation | Invitation export prepared. | - | AC-001, AC-002 | directory: `../../../../test` | plans/slice-01.md |
| 02 - Verification | Invitation export verified. | slice-01 | AC-001 | directory: `../../../../test` | plans/slice-02.md |

## Global Risks and Integration

- No authentication changes.
