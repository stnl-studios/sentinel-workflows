# File Purpose Header

```yaml
purpose: Practical eval plan for checking this skill before and after edits.
load_when: Updating the skill or creating an evaluation harness.
do_not_load_when: Running normal feature-spec lifecycle work.
contains: Eval cases, expected behaviors, and failure conditions.
owner: stnl-spec-lifecycle-manager
update_policy: Add cases whenever real failures or regressions appear.
```

# Eval Plan

## Goal

Verify that the skill reliably manages slice-driven specs without ID drift, question bypass, planning mutation, token bloat, or polluted closure output.

## Eval cases

### E-001 — INIT from vague request

Prompt:

```text
MODE: INIT
Create a spec for improving onboarding.
```

Expected:

- asks crucial questions;
- creates `Q-001+` if drafting partial spec;
- does not mark spec `ready`;
- does not invent detailed business rules.

Fail if:

- creates ready slices without enough context;
- has no questions;
- writes implementation tasks as slices.

---

### E-002 — INIT from clear request

Prompt:

```text
MODE: INIT
Create a spec for expiring invitations after 7 days. Existing invitation lookup fields must remain compatible. No UI changes.
```

Expected:

- creates canonical `AC`, `C`, `R`, `SL` IDs;
- no unnecessary questions if enough context exists;
- includes validation hints;
- includes compact traceability.

Fail if:

- over-asks irrelevant questions;
- creates `F-001`;
- duplicates AC prose inside the matrix.

---

### E-003 — PLANNING blocks open questions

Input spec contains `Q-001` with `status: open`.

Expected:

```yaml
planning_status: blocked_by_open_questions
blockers: [Q-001]
```

Fail if:

- returns `ready`;
- says execution agents can assume the answer.

---

### E-004 — PLANNING does not replan

Input spec contains an oversized `SL-001`.

Expected:

```yaml
planning_status: blocked_needs_resume_replan
next_mode: RESUME
```

Fail if:

- splits the slice during `PLANNING`;
- creates new `SL-###` IDs in `PLANNING`.

---

### E-005 — RESUME reslices without renumbering

Input has `SL-001`, `SL-002`, and oversized `SL-001`.

Expected:

- preserves `SL-001` and `SL-002` IDs;
- creates new slices starting at `SL-003` if needed;
- does not fill gaps;
- updates traceability compactly.

Fail if:

- renumbers existing slices;
- creates invalid IDs.

---

### E-006 — qa_checklist is not a test plan

Expected:

- checklist references IDs;
- no test framework names;
- no test code;
- no scenario steps.

Fail if:

- contains Jest/Cypress/Playwright/Postman steps;
- includes assertions or fixtures.

---

### E-007 — finalizer atomicity

Input says coder succeeded but reviewer failed.

Expected:

- no spec update;
- no partial completion summary;
- instruct rerun from same canonical spec state.

Fail if:

- marks `SL-001` done;
- records failed attempt in spec.

---

### E-008 — CLOSE removes execution history

Input spec has completed slices, operational notes, and resolved questions.

Expected:

- final single `feature_spec.md`;
- no detailed slice history;
- durable decisions preserved;
- resolved questions converted to durable rules only when useful.

Fail if:

- keeps agent logs;
- keeps full slice history;
- creates archive/changelog by default.

## Efficiency checks

Fail if output:

- repeats AC text inside slices and matrix;
- includes long explanatory prose in `qa_checklist`;
- includes examples without being asked;
- includes references unrelated to the MODE;
- preserves empty optional fields that do not add signal.
