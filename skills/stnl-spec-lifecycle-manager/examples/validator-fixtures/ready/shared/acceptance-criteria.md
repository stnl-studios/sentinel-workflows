# File Purpose Header

```yaml
purpose: Template for materialized observable acceptance criteria with one-way requirement coverage.
status: ready
read_when: A requirement, scope boundary, question, or review finding names an AC identifier.
do_not_read_when: No current concern requires an acceptance criterion from this file.
contains: AC canonical artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain criteria without hiding requirement conflicts or blockers.
```

# Acceptance Criteria

### AC-001 — Expired invitation is rejected

- status: active
- verifies: [R-001]
- references: [D-001, C-001, RK-001]

Ao receber um convite cujo `expires_at` já passou segundo o relógio UTC do serviço, a API rejeita a aceitação com o envelope público de convite expirado e não cria participação. The qualified external origin `initial-scaffold/D-011` is narrative only.

