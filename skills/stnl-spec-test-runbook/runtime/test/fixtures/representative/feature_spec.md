# File Purpose Header

```yaml
purpose: Active documentary SPEC for invitation acceptance behavior.
status: ready
read_when: Discovering invitation acceptance scope, requirements, blockers, or canonical records.
do_not_read_when: An indexed canonical item already provides the complete needed detail.
contains: Invitation acceptance context, derived requirements, canonical artifact index, blockers, and selective-reading instructions.
owner: stnl-spec-lifecycle-manager
update_policy: INIT created it; RESUME maintains documentary authority; CLOSE replaces it with the durable final form.
```

# Invitation Acceptance - Feature SPEC

## Objective

Allow an invited user to accept one valid invitation exactly once while expired invitations remain rejected.

## Context

### Facts

- Invitations already contain a UTC expiration timestamp.
- Acceptance creates a participation record and exposes its generated identifier.

### Hypotheses

- Confirmation copy may require a later product decision without changing the API contract.

## Scope

- Accept eligible invitations.
- Reject expired invitations without participation.
- Preserve automated delivery telemetry coverage.

## Out of Scope

- Changing invitation delivery channels.
- Granting manual production-log access.

## Requirements

- R-001
- R-002
- R-003

## Business Rules

- The service UTC clock determines whether an invitation is expired.
- One invitation cannot create duplicate participation.

## Relevant Contracts

- The existing public HTTP response envelope remains stable.

## Canonical Artifact Index

```yaml
artifacts:
  requirements: shared/requirements.md
  acceptance_criteria: shared/acceptance-criteria.md
  risks: shared/risks.md
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

