# File Purpose Header

```yaml
purpose: Define how external agents consume a modular slice-driven spec workspace and how developers complete slices manually.
load_when: Preparing context for orchestrated agents or completing a slice after a successful round.
do_not_load_when: Only drafting initial product intent.
contains: Agent roles, selective handoff, spec-state atomicity, write permissions, failure behavior, reviewer payload, and developer completion protocol.
owner: stnl-spec-lifecycle-manager
update_policy: Change when the external agent pipeline or developer completion rules change.
```

# Agent Execution Contract

This skill prepares modular specs for external execution. It does not implement the slice itself.

## External Pipeline

A slice is executed by a full agent round:

```text
orchestrator -> planner -> developer approval -> test-planner -> developer approval -> coder -> validator -> reviewer -> developer completion
```

The reviewer is the last agent. After Reviewer `PASS`, the orchestrator returns control to the developer and invokes no other agent.

## Selective Handoff

The orchestrator discovers the workspace through operational `feature_spec.md`, reads the candidate slice file, resolves only linked IDs, and passes a minimal in-memory package to the next eligible agent.

The orchestrator may locate headings by ID, read explicitly linked blocks, copy those blocks into the disposable handoff, and verify referenced paths exist. It may not interpret requirements, replan, decide whether an AC is correct, judge quality, alter the spec, read source code, or create a persistent package.

Agents do not read the whole spec workspace by default. Additional reads by non-orchestrator roles must be justified, targeted, and limited to the files needed for the current role.

No permanent slice context package is created.

## Spec-State Atomicity

The slice execution round is atomic only with respect to the canonical spec state. This is not a filesystem transaction and does not promise crash-safe multi-file writes.

| Round result | Spec workspace update |
|---|---|
| planner fails | no update |
| test planner fails | no update |
| coder fails | no update |
| validator fails | no update |
| reviewer fails | no update |
| reviewer passes | developer may apply manual completion |

Partial success is not recorded in the canonical spec workspace. Code changes may remain in the working tree for correction. Until the developer completes the manual update, the slice remains in its previous canonical status.

## Write Permissions

| Agent or mode | May update spec workspace? |
|---|---:|
| orchestrator | no |
| planner | no |
| test planner | no |
| coder | no |
| validator | no |
| reviewer | no |
| developer | yes |
| `stnl-spec-lifecycle-manager` explicitly invoked | yes |

The workspace of the spec may be altered only by the developer or by this skill when explicitly invoked in `INIT`, `RESUME`, `PLANNING`, or `CLOSE`. `PLANNING` remains read-only.

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

## Reviewer PASS Payload

On `PASS`, the reviewer must provide a compact disposable handoff containing:

- slice ID;
- ACs considered satisfied;
- Validator status;
- Reviewer status;
- mandatory evidence summary;
- DoD met or pending;
- accepted risks;
- durable discovery candidates;
- required follow-up slices;
- remaining blockers;
- changed paths;
- next manual action.

The reviewer does not edit the spec, mark the slice done, create files, change requirements, record durable discoveries directly, or close the spec.

## Developer Completion Protocol

After Validator `PASS` and Reviewer `PASS`, the developer may update manually:

- `slices/SL-###.md`;
- `shared/decisions.md`, when a durable decision exists;
- `shared/constraints.md`, when a durable constraint exists;
- `shared/risks.md`, when a durable risk exists;
- new follow-up slice files only when truly necessary;
- `lifecycle/traceability.md`;
- `lifecycle/qa-checklist.md`;
- `lifecycle/resume-notes.md`;
- compact metadata and indexes in `feature_spec.md`.

The developer must not change acceptance criteria to hide a divergence. If an AC, requirement, or scope must change, do not complete the slice; return to `MODE=RESUME`.

Minimum manual completion steps:

1. confirm Validator `PASS`;
2. confirm Reviewer `PASS`;
3. confirm mandatory evidence;
4. confirm ACs satisfied;
5. confirm applicable DoD;
6. mark the slice `done`;
7. fill compact `completion_summary`;
8. register relevant accepted risks;
9. register durable discoveries;
10. update traceability, QA, resume notes, and index metadata.

Recommended compact summary:

```yaml
completion_summary:
  result: <objective slice result>
  satisfied_acceptance_criteria: [AC-001, AC-002]
  validation:
    mandatory_evidence: pass
    validator: PASS
    reviewer: PASS
    commands:
      - <summarized command or validation>
  dod:
    status: met
    pending: []
  new_decisions: []
  new_constraints: []
  new_risks: []
  accepted_risks: []
  follow_up_slices: []
```

Do not store complete logs, diffs, agent transcripts, failed attempts, internal reasoning, long command output, or detailed operational history.

## Manual Update Consistency Rule

Before another slice starts after a manual completion, validate:

- the completed slice is `done`;
- indexes agree with files;
- traceability agrees with slice links;
- QA checklist reflects actual blockers/readiness;
- resume notes point to the correct next candidate;
- no acceptance criteria were rewritten to mask drift.

If interruption occurs during manual completion:

1. read the compact index;
2. read the current slice;
3. verify traceability, QA, and resume notes;
4. detect whether the manual update is partial;
5. block new execution until consistency is restored;
6. the developer restores consistency directly or invokes `MODE=RESUME`.

## Failure Handling

If execution fails, rerun the needed external pipeline from the same canonical spec workspace state.

Do not mark the slice as partially complete. Do not mutate the spec to reflect failed intermediate work.
