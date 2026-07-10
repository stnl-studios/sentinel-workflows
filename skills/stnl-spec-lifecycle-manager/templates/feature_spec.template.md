# File Purpose Header

```yaml
purpose: Template for an active documentary feature SPEC.
status: draft
read_when: Discovering documentary status, scope, blockers, or materialized canonical records.
do_not_read_when: An indexed canonical item already provides the complete needed detail.
contains: Requirements context, compact artifact index, blockers, and selective-reading instructions.
owner: stnl-spec-lifecycle-manager
update_policy: INIT creates it; RESUME updates documentary content; CLOSE replaces it with the durable final form.
```

# <Feature Name> - Feature SPEC

## Objective

<Concise intended outcome and value.>

## Context

### Facts

- <Known factual context.>

### Hypotheses

- <Explicitly uncertain context, or "None identified.">

## Scope

- <Included behavior or boundary.>

## Out of Scope

- <Excluded behavior or boundary.>

## Requirements

- <Requirement or contract expectation.>

## Business Rules

- <Rule, or "None.">

## Relevant Contracts

- <API, data, legal, compatibility, or integration contract, or "None.">

## Canonical Artifact Index

```yaml
artifacts:
  acceptance_criteria: shared/acceptance-criteria.md
  decisions: shared/decisions.md
  constraints: shared/constraints.md
  risks: shared/risks.md
  questions: shared/questions.md
```

## Blockers

```yaml
open_questions: []
broken_references: []
documentary_gaps: []
```

## Selective Reading

1. Read this file's purpose header and artifact index.
2. Map the needed canonical ID to its indexed category.
3. Open only that category file and locate the exact heading.
4. Read the item through the next `###` heading or EOF.
5. Follow only necessary `blocks`, `blocked_by`, `linked_decision`, or `references` links.
