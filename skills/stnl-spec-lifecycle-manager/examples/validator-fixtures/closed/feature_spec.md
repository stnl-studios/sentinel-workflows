# File Purpose Header

```yaml
purpose: Template for the final lossless documentary feature SPEC.
status: closed
read_when: Maintaining, validating, extending, or revisiting the closed feature requirements.
do_not_read_when: Looking for session history, implementation evidence, or delivery records.
contains: Durable objective, context, scope, rules, exact canonical items, contracts, and all final questions.
owner: stnl-spec-lifecycle-manager
update_policy: Update only through an explicit future documentary lifecycle action.
```

# Fixture Feature - Feature SPEC

## Objective

Provide deterministic invitation expiration behavior.

## Context

### Facts

- Invitations already contain an UTC expiration timestamp.

### Hypotheses

- None identified.

## Final Scope

- Reject acceptance after the stored expiration timestamp.

## Out of Scope

- Changing invitation delivery channels.

## Requirements

### R-001 — Expired invitation is rejected

- status: in_scope

An invitation past `expires_at` according to the service UTC clock is rejected without creating participation.

## Business Rules

- The service clock is the time authority.

## Final Acceptance Criteria

### AC-001 — Expired invitation is rejected

- status: active
- verifies: [R-001]
- references: [D-001, C-001, RK-001]

Ao receber um convite cujo `expires_at` já passou segundo o relógio UTC do serviço, a API rejeita a aceitação com o envelope público de convite expirado e não cria participação. The qualified external origin `initial-scaffold/D-011` is narrative only.

## Durable Decisions

### D-001 — Service clock is authoritative

- status: accepted
- references: [C-001]

#### Contexto

Client clocks can diverge and cannot produce a consistent expiration result.

#### Decisão

The service compares `expires_at` with its own UTC clock.

#### Impacto

All clients observe one deterministic expiration decision.

## Relevant Constraints

### C-001 — Public error envelope remains stable

- status: active
- references: [D-001]

#### Restrição

Expired invitations use the existing public HTTP error envelope.

#### Razão

Clients already depend on that response contract.

## Relevant Risks

### RK-001 — Clock drift near expiration boundary

- status: active
- impact: medium
- references: [C-001, AC-001]

#### Risco

Clock drift between service nodes can change the result near the expiration boundary.

#### Mitigação

Synchronize nodes, monitor drift, and retain the risk as active while it remains material.

## Important Contracts

- `docs/core/CONTRACTS.md §5` defines the HTTP error envelope.

## Durable Resolved Questions

### Q-001 — Which clock determines expiration

- status: resolved
- classification: blocking
- resolved_by: decision
- linked_decision: D-001

#### Pergunta

Which clock determines whether an invitation is expired?

#### Por que importa

The answer changes the result observed by AC-001.

#### Resolução

D-001 explicitly establishes the service UTC clock as authority.

