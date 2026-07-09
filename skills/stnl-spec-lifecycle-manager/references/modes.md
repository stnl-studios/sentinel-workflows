# File Purpose Header

```yaml
purpose: Define lifecycle MODE behavior for modular spec workspaces.
load_when: The skill must decide or execute INIT, RESUME, PLANNING, or CLOSE.
do_not_load_when: The task is only about canonical ID syntax or token economy.
contains: Mode responsibilities, allowed mutations, blocking behavior, transition rules, and workspace-specific outputs.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when lifecycle semantics change.
```

# Lifecycle MODEs

The skill operates in exactly one MODE per invocation.

## `INIT`

Use `INIT` to start a new modular operational spec workspace.

### Responsibilities

- Choose the workspace root, defaulting to `specs/<feature-slug>/` when no stronger consumer convention exists.
- Create `feature_spec.md` as a compact index and manifest.
- Create shared artifact files only for materialized categories.
- Create one `slices/SL-###.md` file per proposed slice when there is enough signal.
- Create `lifecycle/traceability.md`, `lifecycle/qa-checklist.md`, and `lifecycle/resume-notes.md`.
- Ask crucial questions when the request is vague, contradictory, risky, or too superficial.
- Create canonical artifacts only when supported by the input.
- Keep the index, traceability, QA checklist, and resume notes consistent.

### Allowed changes

`INIT` may create the workspace and initial artifacts.

### Blocking conditions

Block or ask questions when:

- the feature objective is unclear;
- user/business impact is unknown and materially affects scope;
- acceptance criteria cannot be derived safely;
- a critical integration, data, permission, security, or migration detail is missing;
- a proposed slice would require assumptions that should be explicit.

When blocked, create `shared/questions.md` plus the lifecycle files needed to represent the blocked state. Do not create a `ready` slice while any question is open.

### Output

Return either:

- the created modular workspace;
- a blocked partial workspace with `Q-001+`;
- or the smallest set of crucial questions when no artifact can be safely created.

Do not create a monolithic operational `feature_spec.md`.

---

## `RESUME`

Use `RESUME` to continue an existing workspace, update planning, migrate the previous monolithic operational shape, or re-slice work.

### Responsibilities

- Start by reading `feature_spec.md` and `lifecycle/resume-notes.md`.
- Load only the candidate slice and linked artifacts unless more is justified.
- Preserve all valid canonical IDs exactly.
- Compute next IDs by scanning the whole workspace, not only loaded files.
- Detect open questions, blockers, oversized slices, undersized slices, missing links, stale readiness, and broken paths.
- Replan slices when requested or when `PLANNING` previously blocked with `needs_resume_replan`.
- Create new artifacts using the next available ID.
- Keep index, traceability, QA checklist, and resume notes consistent.

### Allowed changes

`RESUME` may:

- add new `Q`, `D`, `AC`, `C`, `R`, or `SL` artifacts;
- mark artifacts as resolved, blocked, superseded, mitigated, obsolete, dropped, or done;
- split an oversized slice into new slice files;
- merge the intent of undersized planned slices into a more appropriate new slice file;
- migrate a previous monolithic operational `feature_spec.md` into the modular workspace;
- update affected lifecycle files and compact index metadata.

### Restrictions

- Never renumber existing IDs.
- Never reuse gaps.
- Never mutate a completed slice into new work. Create a new slice instead.
- Never silently bypass open questions.
- Never update unrelated files.
- Never create a permanent slice context package.

### Monolithic operational input

If an existing operational spec stores questions, decisions, ACs, constraints, risks, slices, traceability, QA checklist, and resume notes inside one `feature_spec.md`, treat it as the previous contract. Require `RESUME` migration before readiness:

- preserve valid IDs;
- distribute content to the canonical files;
- remove duplicated prose;
- do not renumber;
- update traceability and indexes.

### Output

Return the updated workspace or the exact patch/update needed.

---

## `PLANNING`

Use `PLANNING` to validate readiness before implementation or resumption.

### Responsibilities

- Start from `feature_spec.md`.
- Read `lifecycle/resume-notes.md` when validating next-slice continuity.
- Read the candidate slice file and only linked shared artifact blocks.
- Validate workspace paths, File Purpose Headers, IDs, references, slice filename/heading/id consistency, traceability, QA state, and open questions.
- Identify blockers by canonical ID.
- Return a readiness verdict.

### Restrictions

`PLANNING` must be read-only. It must not create, edit, split, merge, or delete files.

If structural change is needed, return:

```yaml
planning_status: blocked
reason: needs_resume_replan
next_mode: RESUME
```

### Valid verdicts

- `ready`
- `blocked_by_open_questions`
- `blocked_needs_resume_replan`
- `incomplete_spec`
- `incomplete_slice_readiness`
- `invalid_canonical_ids`
- `broken_workspace_references`

---

## `CLOSE`

Use `CLOSE` to finalize the workspace.

### Responsibilities

- Validate no open questions remain.
- Validate durable information has been consolidated.
- Produce exactly one final `feature_spec.md`.
- Remove `shared/`, `slices/`, and `lifecycle/`.
- Preserve objective, final scope, out of scope, business rules, final acceptance criteria, durable decisions, relevant constraints, relevant risks, and essential technical notes.

### Restrictions

- Do not preserve detailed slice execution history.
- Do not preserve lifecycle checklist details, resume notes, failed attempts, logs, intermediate plans, or operational handoffs.
- Do not create archives or changelogs unless explicitly requested outside this skill contract.
- Do not leave TODOs, speculative notes, or implementation logs.

### Output

A clean `feature_spec.md` suitable for future maintenance with low token cost. After successful `CLOSE`, the feature folder contains no `shared/`, `slices/`, or `lifecycle/` directories.
