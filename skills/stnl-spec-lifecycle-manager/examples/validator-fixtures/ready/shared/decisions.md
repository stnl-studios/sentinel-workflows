# File Purpose Header

```yaml
purpose: Template for materialized durable decisions.
status: ready
read_when: Scope, requirements, a question resolution, or a review finding names a decision identifier.
do_not_read_when: No current concern requires a decision from this file.
contains: D canonical artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain decisions with complete context and impact.
```

# Decisions

### D-001 — Service clock is authoritative

- status: accepted
- references: [C-001]

#### Contexto

Client clocks can diverge and cannot produce a consistent expiration result.

#### Decisão

The service compares `expires_at` with its own UTC clock.

#### Impacto

All clients observe one deterministic expiration decision.

