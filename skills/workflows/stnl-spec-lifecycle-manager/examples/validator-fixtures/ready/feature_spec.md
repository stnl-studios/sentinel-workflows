# File Purpose Header

```yaml
purpose: Template for an active documentary feature SPEC.
status: ready
read_when: Discovering documentary status, scope, blockers, or materialized canonical records.
do_not_read_when: An indexed canonical item already provides the complete needed detail.
contains: Requirements context, derived requirement references, compact artifact index, blockers, and selective-reading instructions.
owner: stnl-spec-lifecycle-manager
update_policy: INIT creates it; RESUME updates documentary content; CLOSE replaces it with the durable final form.
```

# Fixture Feature - Feature SPEC

## Objective

Provide deterministic invitation expiration behavior.

## Context

### Facts

- Invitations already contain an UTC expiration timestamp.

### Hypotheses

- None identified.

## Scope

- Reject acceptance after the stored expiration timestamp.

## Out of Scope

- Changing invitation delivery channels.

## Requirements

- R-001

## Business Rules

- The service clock is the time authority.

## Relevant Contracts

- `docs/core/CONTRACTS.md §5` defines the HTTP error envelope.

## Canonical Artifact Index

```yaml
artifacts:
  requirements: shared/requirements.md
  acceptance_criteria: shared/acceptance-criteria.md
  decisions: shared/decisions.md
  constraints: shared/constraints.md
  risks: shared/risks.md
  questions: shared/questions.md
```

## Blockers

```yaml
blocking_questions: []
documentary_gaps: []
```

## Selective Reading

1. Read this header and artifact index.
2. Map the requested ID to one category file.
3. Read the exact item through the next `###` heading or EOF.
4. Follow only necessary structural metadata links.

