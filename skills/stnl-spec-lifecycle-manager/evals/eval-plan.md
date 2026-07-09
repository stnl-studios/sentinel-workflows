# File Purpose Header

```yaml
purpose: Practical eval plan for checking this skill before and after edits.
load_when: Updating the skill or creating an evaluation harness.
do_not_load_when: Running normal feature-spec lifecycle work.
contains: Modular workspace eval cases, expected behaviors, failure conditions, and regression checks.
owner: stnl-spec-lifecycle-manager
update_policy: Add cases whenever real failures or regressions appear.
```

# Eval Plan

## Goal

Verify that the skill manages modular slice-driven spec workspaces without ID drift, question bypass, planning mutation, token bloat, partial execution persistence, or polluted closure output.

## Eval Cases

### E-001 - INIT Modular

Prompt:

```text
MODE: INIT
Create a spec for expiring invitations after 7 days. Existing invitation lookup fields must remain compatible. No UI changes.
```

Expected:

- creates `specs/<feature-slug>/feature_spec.md` as a compact index;
- creates materialized shared files for ACs, decisions, constraints, and risks;
- creates `slices/SL-001.md`;
- creates `lifecycle/traceability.md`, `lifecycle/qa-checklist.md`, and `lifecycle/resume-notes.md`;
- uses canonical IDs and File Purpose Headers;
- includes validation hints in the slice file.

Fail if:

- creates only an operational `feature_spec.md`;
- puts full slice definitions in the index;
- puts full ACs in the index;
- omits required lifecycle files.

---

### E-002 - INIT Blocked

Prompt:

```text
MODE: INIT
Create a spec for improving onboarding.
```

Expected:

- creates or returns `Q-001+` for crucial ambiguity;
- keeps spec readiness blocked;
- creates no `ready` slice;
- materializes `shared/questions.md`;
- represents absent shared categories explicitly in `feature_spec.md`;
- creates lifecycle files that represent the blocked state.

Fail if:

- creates ready slices without enough context;
- has no questions;
- invents detailed business rules;
- creates empty shared files for every category without artifacts.

---

### E-003 - Path and Reference Integrity

Input workspace has one or more defects:

- `slices/SL-001.md` declares `id: SL-002`;
- a slice references missing `AC-999`, `D-999`, `C-999`, `R-999`, or `Q-999`;
- `feature_spec.md` indexes a missing file;
- `lifecycle/traceability.md` diverges from slice links.

Expected:

```yaml
planning_status: broken_workspace_references
next_mode: RESUME
```

Fail if:

- returns `ready`;
- silently fixes files during `PLANNING`;
- ignores filename/heading/id mismatch.

---

### E-004 - Selective Reading

Input workspace has a ready `SL-001` linked to `AC-001`, `AC-002`, `C-001`, `R-001`, and `D-001`.

Expected:

- slice package can be assembled from `feature_spec.md`, `slices/SL-001.md`, and only linked shared artifact blocks;
- lifecycle files are loaded only if the role or MODE requires them;
- no whole-workspace read is required;
- no permanent context package is created.

Fail if:

- instructs agents to read every spec file by default;
- duplicates shared artifact prose in the slice;
- creates `slice-context.md`, `context-package.md`, or equivalent.

---

### E-005 - PLANNING Read-Only

Input workspace contains an oversized or inconsistent slice.

Expected:

```yaml
planning_status: blocked_needs_resume_replan
next_mode: RESUME
```

Fail if:

- splits the slice during `PLANNING`;
- creates or edits any file;
- creates new `SL-###` IDs in `PLANNING`.

---

### E-006 - RESUME Reslices Without Renumbering

Input has `SL-001`, `SL-002`, and oversized `SL-001`.

Expected:

- preserves `SL-001` and `SL-002` IDs;
- creates new slices starting at `SL-003` if needed;
- does not fill gaps;
- updates only affected slice files, index, traceability, QA, and resume notes.

Fail if:

- renumbers existing slices;
- creates invalid IDs;
- mutates a `done` slice into new work.

---

### E-007 - Atomicity

Input says coder succeeded but reviewer failed.

Expected:

- no spec workspace update;
- no partial completion summary;
- no failed-attempt record;
- rerun from the same canonical workspace state.

Fail if:

- marks `SL-001` done;
- writes failed attempt details;
- updates lifecycle files after an incomplete round.

---

### E-008 - Finalizer Allowlist

Input has validator and reviewer `PASS`.

Expected:

- finalizer updates only the completed slice file, allowed durable shared files, follow-up slice files when needed, lifecycle files, and compact index metadata;
- finalizer does not close the spec;
- finalizer does not alter acceptance criteria to hide a requirement change;
- all finalizer changes are one logical atomic update.

Fail if:

- removes `shared/`, `slices/`, or `lifecycle/`;
- writes outside the allowlist;
- creates close-input, final report, log, or history files;
- leaves index or traceability inconsistent.

---

### E-009 - CLOSE Compaction

Input workspace has completed slices, shared artifacts, lifecycle files, and operational notes.

Expected:

- final folder contains only `feature_spec.md`;
- `shared/`, `slices/`, and `lifecycle/` are removed;
- durable ACs, decisions, constraints, risks, rules, and essential notes are preserved;
- operational history is removed.

Fail if:

- keeps agent logs;
- keeps detailed slice history;
- leaves lifecycle files;
- creates archive/changelog by default;
- drops durable final content.

---

### E-010 - Token Economy

Fail if output:

- repeats AC text inside slices;
- repeats artifact descriptions in traceability;
- repeats full shared artifacts inside the index;
- creates a permanent slice context package;
- requires full workspace reads by default;
- preserves empty optional files or fields that do not add signal;
- writes test scenarios, commands, fixtures, or implementation detail into `lifecycle/qa-checklist.md`.
