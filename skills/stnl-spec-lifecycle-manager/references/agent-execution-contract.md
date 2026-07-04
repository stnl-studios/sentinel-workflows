# File Purpose Header

```yaml
purpose: Define how external agents may consume and update a slice-driven spec.
load_when: Preparing context for orchestrated agents or finalizer updates after a successful slice round.
do_not_load_when: Only drafting initial product intent.
contains: Agent roles, atomic execution, write permissions, failure behavior, and finalizer update contract.
owner: stnl-spec-lifecycle-manager
update_policy: Change when the external agent pipeline changes.
```

# Agent Execution Contract

This skill prepares specs for external execution. It does not implement the slice itself.

## External pipeline

A slice is executed by a full agent round:

```text
orchestrator -> planner -> test planner -> coder -> validator -> reviewer -> finalizer
```

## Atomicity

The slice execution round is atomic.

| Round result | Spec update |
|---|---|
| planner fails | no update |
| test planner fails | no update |
| coder fails | no update |
| validator fails | no update |
| reviewer fails | no update |
| finalizer fails | no update |
| full round succeeds | finalizer updates the completed slice |

Partial success is not recorded in the canonical spec.

## Write permissions

| Agent | May update `feature_spec.md`? |
|---|---:|
| orchestrator | no |
| planner | no |
| test planner | no |
| coder | no |
| validator | no |
| reviewer | no |
| finalizer | yes, only the completed slice and durable linked artifacts |
| `CLOSE` mode | yes, the entire final spec |

## Finalizer scope

The finalizer may update:

- the completed `SL-###` status to `done`;
- compact `completion_summary`;
- newly discovered durable `D-###` decisions;
- newly discovered durable `C-###` constraints;
- newly discovered relevant `R-###` risks;
- follow-up `SL-###` slices only if required by durable outcome;
- traceability matrix.

The finalizer must not:

- close the whole spec;
- preserve failed attempts;
- store logs;
- record temporary implementation trivia;
- mark partial work as done;
- bypass open questions.

## Durable discovery rule

Create new decisions only for durable matters:

- business rule;
- API contract;
- data model;
- architecture;
- security or permissions;
- integration behavior;
- compatibility;
- meaningful error behavior.

Do not record local implementation trivia as decisions.

## Context package for execution

The orchestrator should provide a slice package, not the full spec:

```yaml
slice: SL-###
acceptance_criteria: [AC-###]
constraints: [C-###]
risks: [R-###]
decisions: [D-###]
resolved_questions: [Q-###]
validation_hints: <from slice>
context_hints: <from slice>
```

## Failure handling

If execution fails, discard the round output and rerun the full external pipeline from the same canonical spec state.

Do not mark the slice as partially complete. Do not mutate the spec to reflect failed intermediate work.
