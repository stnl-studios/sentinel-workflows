---
name: stnl-spec-lifecycle-manager
description: Use to create, mature, review, resume, and close independent feature SPECs with stable canonical IDs, selective reading, and durable documentary consistency.
---

# stnl-spec-lifecycle-manager

## Purpose

Manage the lifecycle of a feature SPEC as an independent requirements artifact. This skill defines what must be delivered: objective, context, scope, exclusions, requirements, business rules, acceptance criteria, questions, decisions, constraints, risks, and relevant contracts. It does not prescribe how work is planned or delivered.

Consumers may use a ready SPEC for direct implementation, a manual plan, an issue tracker, another skill, an external workflow, or a separate session.

## Required MODE

Operate in exactly one MODE:

- `INIT`: create or mature a new SPEC.
- `RESUME`: update an existing SPEC from explicit new information.
- `PLANNING`: perform a conservative, read-only documentary readiness review.
- `CLOSE`: consolidate a documentary SPEC into one durable file.

Infer a missing MODE only when it is unambiguous; otherwise request the smallest necessary clarification.

## Core invariants

1. An active SPEC has `feature_spec.md` and only the materialized categories in `shared/`; unrelated directories, including a separate execution workspace, are outside this skill's ownership.
2. Canonical IDs are only `Q-###`, `D-###`, `AC-###`, `R-###`, and `C-###`.
3. Each canonical ID appears in its heading and explicit `id:` field. Never renumber, reuse, fill gaps, alter valid casing, or refer to an existing item by title alone.
4. Distinguish facts, hypotheses, and decisions. Never invent a requirement to make a SPEC look complete.
5. Materialize a shared file only when it has real content. A blocked SPEC may contain only `feature_spec.md` and `shared/questions.md`.
6. Read selectively; do not create session logs, permanent context packages, or duplicate traceability artifacts.
7. `PLANNING` is read-only and assesses documentary readiness only.
8. `CLOSE` is documentary closure only. It does not depend on code, tests, diffs, commits, tasks, or operational evidence.

## File Purpose Header

Every applicable workspace artifact, template, reference, example, and eval starts with `# File Purpose Header`, followed by one YAML block containing exactly: `purpose`, `status`, `read_when`, `do_not_read_when`, `contains`, `owner`, and `update_policy`.

Use only `draft`, `ready`, `blocked`, `done`, `closed`, or `not_applicable` for header status. Do not use competing YAML frontmatter, `planned`, `load_when`, or `do_not_load_when`. Keep headers short and oriented to selective reading.

## Lazy-loading map

| Operation | Read |
|---|---|
| INIT | `references/modes.md`, `spec-workspace.md`, `canonical-ids.md`, `question-policy.md`, `spec-schema.md`, and only needed templates |
| RESUME | `modes.md`, `spec-workspace.md`, `canonical-ids.md`, `question-policy.md`, `readiness-gates.md`, and only affected artifacts |
| PLANNING | `modes.md`, `readiness-gates.md`, `spec-schema.md`, `canonical-ids.md`, and the relevant SPEC artifacts |
| CLOSE | `close-policy.md`, `readiness-gates.md`, `spec-schema.md`, `canonical-ids.md`, and only materialized artifacts needed for consolidation |

Load examples only to clarify a format. Do not browse source code merely to turn a SPEC review into implementation planning.

## MODE summaries

### INIT

Create the workspace, `feature_spec.md`, and only needed shared artifacts. Record the smallest blocking questions. Capture supplied facts, hypotheses, and decisions without fabricating requirements. Do not implement code or create operational planning artifacts.

### RESUME

Incorporate explicit answers and changes, resolve inconsistencies, update scope and criteria, and record durable decisions. Preserve valid IDs and prior decisions that remain relevant. Make changes visible; never rewrite history solely to erase a relevant decision. Do not create operational artifacts.

### PLANNING

Review documentary readiness without modifying files. Verify objective, context, scope, exclusions when needed, requirements, verifiable criteria, blockers, pending decisions, contradictions, constraints, risks, references, duplication, and whether an external consumer can use the SPEC.

Return `READY`, or `NEEDS_RESUME` followed only by actionable documentary findings and their affected artifact or canonical ID.

### CLOSE

Validate documentary consistency and absence of blocking questions, references, and unresolved contradictions. Consolidate durable content into one `feature_spec.md` and remove materialized lifecycle auxiliary files only after their necessary content is incorporated; leave external directories untouched. The final file preserves durable requirements context, not session history or operational records.

## Evaluation

Read `references/eval-guidance.md` and use `evals/eval-cases.md` when changing this skill. Validate the SPEC-only boundary, IDs, selective reading, gates, headers, and documentary closure.
