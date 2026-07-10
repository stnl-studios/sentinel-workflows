# File Purpose Header

```yaml
purpose: Template for the final lossless documentary feature SPEC.
status: closed
read_when: Maintaining, validating, extending, or revisiting the closed feature requirements.
do_not_read_when: Looking for session history, implementation evidence, or delivery records.
contains: Durable objective, context, scope, rules, canonical items, contracts, and relevant resolved questions.
owner: stnl-spec-lifecycle-manager
update_policy: Update only through an explicit future documentary lifecycle action.
```

# <Feature Name> - Feature SPEC

## Objective

<Durable outcome and value.>

## Context

### Facts

- <Facts needed to interpret the final requirements.>

### Hypotheses

- <Remaining explicit hypothesis, or "None identified.">

## Final Scope

- <Included behavior.>

## Out of Scope

- <Durable exclusion.>

## Requirements

- <Final requirement.>

## Business Rules

- <Durable rule, or "None.">

## Final Acceptance Criteria

### AC-001 — <Criterion title>

- status: active
- blocked_by: [Q-001]
- references: [D-001, C-001]

Dado <estado observável>, quando <ação>, então <resultado verificável>.

## Durable Decisions

### D-001 — <Decision title>

- status: accepted
- references: [C-001]

#### Contexto

<Why this decision exists.>

#### Decisão

<The durable choice.>

#### Impacto

<The lasting consequence.>

## Relevant Constraints

### C-001 — <Constraint title>

- status: active
- references: [D-001]

#### Restrição

<Boundary that must not be violated.>

#### Razão

<Why the boundary matters.>

## Relevant Risks

### R-001 — <Risk title>

- status: active
- impact: high
- references: [C-001, AC-001]

#### Risco

<Material exposure that remains relevant.>

#### Mitigação

<Treatment without erasing the active risk.>

## Important Contracts

- <Durable API, data, legal, compatibility, or integration contract.>

## Durable Resolved Questions

### Q-001 — <Question title>

- status: resolved
- blocks: [AC-001]
- resolved_by: decision
- linked_decision: D-001

#### Pergunta

<The material question.>

#### Por que importa

<Why the answer established a durable boundary.>

#### Resolução

<Explicit resolution preserved because it explains D-001.>
