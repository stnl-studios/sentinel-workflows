# File Purpose Header

```yaml
purpose: Define how external agents consume and update a modular slice-driven spec workspace.
load_when: Preparing context for orchestrated agents or finalizer updates after a successful slice round.
do_not_load_when: Only drafting initial product intent.
contains: Agent roles, selective handoff, atomic execution, write permissions, failure behavior, and finalizer update allowlist.
owner: stnl-spec-lifecycle-manager
update_policy: Change when the external agent pipeline or finalizer allowlist changes.
```

# Agent Execution Contract

This skill prepares modular specs for external execution. It does not implement the slice itself.

## External Pipeline

A slice is executed by a full agent round:

```text
orchestrator -> planner -> test planner -> coder -> validator -> reviewer -> finalizer
```

## Selective Handoff

The orchestrator discovers the workspace through operational `feature_spec.md`, reads the candidate slice file, resolves only linked IDs, and passes a minimal in-memory package to the next eligible agent.

Agents do not read the whole spec workspace by default. Additional reads must be justified, targeted, and limited to the files needed for the current role.

No permanent slice context package is created.

## Atomicity

The slice execution round is atomic.

| Round result | Spec workspace update |
|---|---|
| planner fails | no update |
| test planner fails | no update |
| coder fails | no update |
| validator fails | no update |
| reviewer fails | no update |
| finalizer fails | no update |
| full round succeeds | finalizer applies one logical workspace update |

Partial success is not recorded in the canonical spec workspace.

## Write Permissions

| Agent or mode | May update spec workspace? |
|---|---:|
| orchestrator | no |
| planner | no |
| test planner | no |
| coder | no |
| validator | no |
| reviewer | no |
| finalizer | yes, allowlist only after full success |
| `CLOSE` mode | yes, compacts to final one-file spec |

## Finalizer Allowlist

After validator and reviewer both pass, the finalizer may update only:

- the completed `slices/SL-###.md`;
- new durable artifacts in `shared/decisions.md`;
- new durable artifacts in `shared/constraints.md`;
- new durable artifacts in `shared/risks.md`;
- new follow-up `slices/SL-###.md` files when truly required;
- `lifecycle/traceability.md`;
- `lifecycle/qa-checklist.md`, only to reflect real state;
- `lifecycle/resume-notes.md`;
- compact metadata and indexes in `feature_spec.md`.

The finalizer must not update `shared/acceptance-criteria.md` to hide a changed requirement. Requirement changes block and return to `RESUME`.

## Finalizer Must Not

- close the whole spec;
- remove `shared/`, `slices/`, or `lifecycle/`;
- preserve failed attempts;
- store logs;
- record temporary implementation trivia;
- mark partial work as done;
- bypass open questions;
- write outside the allowlist;
- create context package files, close-input files, history files, or final reports.

## Durable Discovery Rule

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

## Finalizer Atomic Update Rule

The finalizer update must be one logical patch. Before considering it complete, validate:

- the completed slice is `done`;
- indexes agree with files;
- traceability agrees with slice links;
- QA checklist reflects actual blockers/readiness;
- resume notes point to the correct next candidate;
- no forbidden file was changed;
- no acceptance criteria were rewritten to mask drift.

If any validation fails, revert the entire spec patch and leave the workspace in the previous canonical state.

## Failure Handling

If execution fails, discard the round output and rerun the full external pipeline from the same canonical spec workspace state.

Do not mark the slice as partially complete. Do not mutate the spec to reflect failed intermediate work.
