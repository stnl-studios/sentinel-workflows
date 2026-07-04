# File Purpose Header

```yaml
purpose: Define the four lifecycle MODEs and their allowed behavior.
load_when: The skill must decide or execute INIT, RESUME, PLANNING, or CLOSE.
do_not_load_when: The task is only about canonical ID syntax or token economy.
contains: Mode responsibilities, mode outputs, blocking behavior, and transition rules.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when lifecycle semantics change.
```

# Lifecycle MODEs

The skill operates in exactly one MODE per invocation.

## `INIT`

Use `INIT` to start a new `feature_spec.md`.

### Responsibilities

- Understand the user's feature intent.
- Ask crucial questions when the request is vague, contradictory, risky, or too superficial.
- Create the first canonical artifacts:
  - `Q-001+` open questions;
  - `D-001+` decisions if already known;
  - `AC-001+` acceptance criteria;
  - `C-001+` anti-drift constraints;
  - `R-001+` risks;
  - `SL-001+` slices.
- Create a compact `qa_checklist` as a Spec Quality Gate.
- Create a compact traceability matrix using IDs only.

### Allowed changes

`INIT` may create the spec and initial artifacts.

### Blocking conditions

Block or ask questions when:

- the feature objective is unclear;
- user/business impact is unknown and materially affects scope;
- acceptance criteria cannot be derived safely;
- a critical integration, data, permission, security, or migration detail is missing;
- a proposed slice would require assumptions that should be explicit.

### Output

Return either:

- a new draft spec;
- a set of crucial questions;
- or a partial spec with explicit blockers.

Do not mark any slice `ready` while open questions exist.

---

## `RESUME`

Use `RESUME` to continue an existing spec, update planning, or re-slice work.

### Responsibilities

- Read the current spec state.
- Preserve all valid canonical IDs exactly.
- Compute the next available ID by artifact type.
- Detect open questions, blockers, oversized slices, undersized slices, missing links, and stale readiness.
- Replan slices when requested or when `PLANNING` previously blocked with `needs_resume_replan`.
- Create new artifacts using the next available ID.

### Allowed changes

`RESUME` may:

- add new `Q`, `D`, `AC`, `C`, `R`, or `SL` artifacts;
- mark artifacts as resolved, blocked, superseded, mitigated, obsolete, dropped, or done;
- split an oversized slice into new slices;
- merge the intent of undersized slices into a more appropriate new slice;
- update traceability.

### Restrictions

- Never renumber existing IDs.
- Never reuse gaps.
- Never mutate a completed slice into new work. Create a new slice instead.
- Never silently bypass open questions.

### Output

Return the updated spec or the exact patch/update needed.

---

## `PLANNING`

Use `PLANNING` to validate readiness before implementation or resumption.

### Responsibilities

- Validate the spec against readiness gates.
- Validate each candidate slice against slice readiness.
- Identify blockers by canonical ID.
- Identify missing required fields.
- Identify oversized or undersized slices.
- Validate traceability links.
- Return a readiness verdict.

### Restrictions

`PLANNING` must not replan, restructure, split, merge, or create slices.

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

---

## `CLOSE`

Use `CLOSE` to finalize the spec.

### Responsibilities

- Produce exactly one final `feature_spec.md`.
- Remove execution history.
- Remove operational noise.
- Remove resolved questions unless they preserve durable business or technical context.
- Keep only final rules, durable decisions, relevant constraints, relevant risks, final acceptance criteria, and essential technical notes.

### Restrictions

- Do not preserve detailed slice execution history.
- Do not create archives or changelogs unless explicitly requested outside this skill contract.
- Do not leave TODOs, speculative notes, failed attempts, or implementation logs.

### Output

A clean `feature_spec.md` suitable for future maintenance with low token cost.
