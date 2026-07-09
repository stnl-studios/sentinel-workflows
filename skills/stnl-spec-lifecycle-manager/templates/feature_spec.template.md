# File Purpose Header

```yaml
purpose: Template for the active documentary feature SPEC.
status: draft
read_when: Discovering the SPEC purpose, scope, blockers, or materialized records.
do_not_read_when: A linked canonical artifact already provides the needed detail.
contains: Metadata, requirements context, artifact index, blockers, and selective reading.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME update documentary content; CLOSE replaces it with the final SPEC.
```

# <Feature Name> - Feature SPEC

## SPEC Metadata

```yaml
spec_id: <feature-slug>
workspace_root: specs/<feature-slug>
spec_status: draft
created_from_mode: INIT
last_updated_mode: INIT
open_question_count: 0
```

## Objective

<Concise intended outcome and value.>

## Context

- Facts: <Known factual context.>
- Hypotheses: <Explicitly uncertain context, if any.>

## Scope

- <Included behavior or boundary.>

## Out of Scope

- <Excluded behavior or boundary, when needed.>

## Requirements

- <Requirement or contract expectation.>

## Business Rules

- <Rule, when applicable.>

## Relevant Contracts

- <API, data, legal, compatibility, or integration contract.>

## Canonical Artifact Index

```yaml
artifacts:
  acceptance_criteria: {file: null, count: 0, materialized: false}
  decisions: {file: null, count: 0, materialized: false}
  constraints: {file: null, count: 0, materialized: false}
  risks: {file: null, count: 0, materialized: false}
  questions: {file: null, count: 0, open_count: 0, materialized: false}
```

## Blockers

```yaml
open_questions: []
broken_references: []
documentary_gaps: []
```

## Selective Reading

1. Read this file first.
2. Load only the shared category and canonical IDs relevant to the current question.
3. Treat each canonical item as authoritative for its category.
4. Do not create duplicate summaries or operational records in this workspace.
