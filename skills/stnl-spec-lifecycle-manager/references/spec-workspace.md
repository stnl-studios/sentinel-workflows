# File Purpose Header

```yaml
purpose: Define the modular operational spec workspace contract.
load_when: Creating, resuming, validating readiness, preparing, or closing a lifecycle-managed spec workspace.
do_not_load_when: Only canonical ID syntax or question wording is needed.
contains: Directory structure, file responsibilities, File Purpose Headers, selective reading, materialization, consistency, migration, and close behavior.
owner: stnl-spec-lifecycle-manager
update_policy: Treat as the canonical workspace contract. Change only when the live spec architecture changes.
```

# Spec Workspace Contract

During `INIT`, `RESUME`, `PLANNING`, and slice execution, the living spec is a modular workspace. It is not a monolithic `feature_spec.md`.

When the user does not provide a path and the consumer repository has no more specific convention, create:

```text
specs/<feature-slug>/
```

## Canonical Tree

```text
specs/<feature-slug>/
├── feature_spec.md
├── shared/
│   ├── acceptance-criteria.md
│   ├── decisions.md
│   ├── constraints.md
│   ├── risks.md
│   └── questions.md
├── slices/
│   ├── SL-001.md
│   ├── SL-002.md
│   └── ...
└── lifecycle/
    ├── traceability.md
    ├── qa-checklist.md
    └── resume-notes.md
```

Shared files are optional until a category has materialized artifacts. Structural lifecycle files are required in every initiated operational workspace. A slice file is required when there is enough signal to propose at least one slice.

For an `INIT` blocked by missing information, the minimum workspace is:

```text
specs/<feature-slug>/
├── feature_spec.md
├── shared/
│   └── questions.md
└── lifecycle/
    ├── traceability.md
    ├── qa-checklist.md
    └── resume-notes.md
```

Do not create empty shared files just to fill the tree. `feature_spec.md` must explicitly say that an absent shared category has no materialized artifacts yet, and consumers must treat that absence as "none materialized", not as an error.

## File Responsibilities

### `feature_spec.md`

Operational `feature_spec.md` is a compact index and manifest. It contains only:

- File Purpose Header;
- metadata;
- objective;
- scope;
- out of scope;
- general state;
- compact artifact counts or indexes;
- canonical paths;
- current slice ID and next candidate slice ID;
- compact blocker summary;
- selective-reading instructions.

It must not contain full acceptance criteria, decisions, constraints, risks, questions, slice definitions, traceability, QA checklist, or resume notes.

### `shared/acceptance-criteria.md`

Contains only `AC-###` artifacts. Agents should locate linked headings by ID and read only the needed block when the file is large.

### `shared/decisions.md`

Contains only durable `D-###` artifacts.

### `shared/constraints.md`

Contains only anti-drift `C-###` artifacts.

### `shared/risks.md`

Contains only material `R-###` artifacts.

### `shared/questions.md`

Contains only `Q-###` artifacts, including status and resolution when applicable.

### `slices/SL-###.md`

Each slice has one file. Filename, heading ID, and explicit `id:` field must match exactly. A slice file contains:

- File Purpose Header;
- heading and `id:`;
- status;
- goal;
- scope;
- out of scope;
- linked IDs;
- dependencies when present;
- validation hints;
- context hints;
- slice readiness;
- compact completion summary when done.

Do not duplicate linked artifact prose in the slice.

### `lifecycle/traceability.md`

Contains a compact matrix based on IDs and paths only when needed. Do not repeat long descriptions.

### `lifecycle/qa-checklist.md`

Contains the Spec Quality Gate. It is not a test plan, BDD scenario list, fixture guide, command list, or implementation plan.

### `lifecycle/resume-notes.md`

Contains only minimal operational state:

- last completed slice;
- next candidate slice;
- blockers;
- IDs and files to load next;
- compact continuity note.

Do not store chat, logs, failed attempts, or execution narrative.

## File Purpose Headers

Every operational spec file must start with a short File Purpose Header containing at least:

```yaml
purpose: <why this file exists>
status: <draft | ready | blocked | done | closed | not_applicable>
read_when: <specific selective-read trigger>
do_not_read_when: <when another narrower file is enough>
contains: <short inventory>
owner: stnl-spec-lifecycle-manager
update_policy: <who may update it and when>
```

Use `status: not_applicable` only when file-level readiness does not apply. The header guides selective reading; it is not a substitute for physical file separation.

## Selective Reading Flow

Default execution context is assembled in memory:

1. Read compact `feature_spec.md`.
2. Discover `next_candidate_slice`.
3. Read only `slices/SL-###.md`.
4. Extract linked IDs from the slice.
5. Read only linked blocks from materialized shared files.
6. Load lifecycle files only when the role or MODE requires them.
7. Pass the minimum slice package to agents.

Never create a permanent "slice context package" file. The package is an orchestrator-to-agent handoff, not a repository artifact.

The minimum package contains:

- current slice;
- linked acceptance criteria;
- linked constraints;
- linked risks;
- linked decisions;
- relevant resolved durable questions;
- validation hints;
- context hints;
- minimal dependencies.

Outside orchestrator handoff assembly, reading the whole spec workspace is allowed only with a concrete justification that the selective package is insufficient. The orchestrator itself must keep to the index, current slice, explicitly linked shared blocks, and lifecycle files needed for routing or continuity.

## Consistency Rules

- `feature_spec.md` may point only to existing files or explicitly absent shared categories.
- Every referenced `AC`, `D`, `C`, `R`, `Q`, and `SL` ID must exist.
- Traceability must agree with slice-linked IDs.
- `lifecycle/resume-notes.md` must agree with `feature_spec.md` for current and next candidate slices.
- `lifecycle/qa-checklist.md` must reflect open questions, broken references, and slice readiness.
- A ready slice cannot reference open questions or missing artifacts.
- `PLANNING` must return `needs_resume_replan` instead of mutating inconsistent structure.

## MODE Behavior

### `INIT`

Create the modular workspace. Materialize shared files only for categories with artifacts. Create lifecycle files. Create slice files only when there is enough signal. Never create a monolithic operational spec.

### `RESUME`

Start from `feature_spec.md` and `lifecycle/resume-notes.md`. Preserve IDs. Compute next IDs by scanning the whole workspace. Create new slice files for reslicing. Update only affected files and keep index, traceability, QA, and resume notes consistent.

### `PLANNING`

Read only what is needed to validate consistency and readiness. Do not create, edit, split, merge, or rewrite files. Block on open questions, broken references, slice-file mismatches, stale traceability, or structural inconsistency.

### External Execution and Developer Completion

No execution agent mutates the spec workspace. After Validator and Reviewer both pass, the developer may manually update only:

- the completed `slices/SL-###.md`;
- durable additions to `shared/decisions.md`;
- durable additions to `shared/constraints.md`;
- durable additions to `shared/risks.md`;
- required follow-up `slices/SL-###.md`;
- `lifecycle/traceability.md`;
- `lifecycle/qa-checklist.md` only to reflect real state;
- `lifecycle/resume-notes.md`;
- compact metadata and indexes in `feature_spec.md`.

The developer must not create or alter acceptance criteria to hide a requirement change. That blocks and returns to `RESUME`.

Spec-state atomicity means the spec does not advance automatically during the agent round. It is not a filesystem transaction. Until the developer completes the manual update, the slice remains in its previous canonical status. An interruption during manual completion requires checking `feature_spec.md`, the current slice, traceability, QA checklist, and resume notes before another slice starts. Restore consistency directly or use `MODE=RESUME`.

### `CLOSE`

Validate no open questions remain and durable content is consolidated. Produce one final `feature_spec.md` and remove `shared/`, `slices/`, and `lifecycle/`. Do not create archives, changelogs, histories, logs, plans, or operational checklists by default.

After successful `CLOSE`, the feature folder contains exactly:

```text
specs/<feature-slug>/
└── feature_spec.md
```

## Monolithic Operational Specs

An existing operational spec that stores all living content in one `feature_spec.md` uses the previous contract. Do not treat it as ready. Require `RESUME` to migrate it into the modular workspace:

- preserve all valid canonical IDs;
- distribute artifacts to the correct files;
- do not renumber or fill gaps;
- remove duplicated prose;
- preserve durable content;
- update traceability, QA, resume notes, and index metadata.

No complex versioning system is required.
