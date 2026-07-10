---
name: stnl-spec-lifecycle-manager
description: Use to create, mature, review, resume, and close independent feature SPECs with deterministic canonical IDs, selective reading, and durable documentary consistency.
---

# stnl-spec-lifecycle-manager

## Purpose

Manage the documentary lifecycle of an independent feature SPEC. The skill owns requirements content—objective, context, scope, exclusions, requirements, rules, acceptance criteria, questions, decisions, constraints, risks, and contracts—but never execution plans, tasks, implementation, or delivery evidence.

Consumers may implement a ready SPEC directly or use any separate delivery workflow.

## Required MODE

Operate in exactly one MODE:

- `INIT`: create a new SPEC; the documentary workspace must not exist.
- `RESUME`: update or mature an existing SPEC; `feature_spec.md` must predate the operation.
- `PLANNING`: perform a conservative, strictly read-only readiness review.
- `CLOSE`: consolidate a ready SPEC into one durable `feature_spec.md`.

Infer a missing MODE only when unambiguous; otherwise request the smallest necessary clarification.

## Core invariants

1. An active workspace has `feature_spec.md` and only materialized categories in `shared/`. Every other directory, including `execution/`, is outside lifecycle ownership.
2. Canonical IDs are only `Q-###`, `D-###`, `AC-###`, `R-###`, and `C-###`. The heading `### ID — Title` is the sole ID authority.
3. Canonical item metadata is a deterministic Markdown list; canonical items never use YAML, repeat `id:`, use optional `null`, renumber, reuse, or fill ID gaps.
4. Structural links are `blocks`, `blocked_by`, `linked_decision`, and `references`. Only these metadata fields participate in automatic internal-ID integrity checks; qualified external references stay narrative.
5. Facts, hypotheses, and decisions remain distinct. Never invent a requirement to make a SPEC appear complete.
6. A materialized shared file has real content. A blocked SPEC may contain only `feature_spec.md` and `shared/questions.md`.
7. `PLANNING` never mutates files or creates operational artifacts.
8. `CLOSE` depends only on documentary gates, preserves durable content before removing `shared/`, and leaves all external directories byte-for-byte unchanged.

## File Purpose Header

Every applicable workspace artifact, template, reference, example, and eval starts with `# File Purpose Header`, followed by one YAML block containing exactly: `purpose`, `status`, `read_when`, `do_not_read_when`, `contains`, `owner`, and `update_policy`.

The header `status` of `feature_spec.md` is the documentary state authority. Use only `draft`, `ready`, `blocked`, `done`, `closed`, or `not_applicable`. Do not add competing metadata blocks.

## Progressive disclosure

| Operation | Read |
|---|---|
| INIT | `references/modes.md`, `spec-workspace.md`, `canonical-ids.md`, `question-policy.md`, `spec-schema.md`, readiness gates when claiming `ready`, and only needed templates |
| RESUME | `modes.md`, `spec-workspace.md`, `canonical-ids.md`, `question-policy.md`, `readiness-gates.md`, and only affected artifacts |
| PLANNING | `modes.md`, `readiness-gates.md`, `spec-schema.md`, `canonical-ids.md`, then only relevant SPEC records |
| CLOSE | `close-policy.md`, `readiness-gates.md`, `spec-schema.md`, `canonical-ids.md`, and all materialized content needed for lossless consolidation |

For a localized ID lookup, follow `references/spec-workspace.md`: read the feature header and index, open one category, locate the exact heading, read through the next `###` or EOF, and follow only necessary structural links.

## MODE outcomes

- `INIT` creates the minimum new workspace and returns its documentary status.
- `RESUME` applies explicit deltas, preserves IDs, and may change status only when gates permit.
- `PLANNING` returns `READY` or `NEEDS_RESUME` with actionable documentary findings and affected artifacts or IDs.
- `CLOSE` validates, consolidates, verifies preservation, removes `shared/`, validates the final form, and confirms external-directory preservation.

## Evaluation

When changing this skill, read `references/eval-guidance.md` and run the executable cases indexed by `evals/eval-cases.md`. Validate the SPEC-only boundary, parser, relationships, readiness, selective reading, closure preservation, and external-directory protection.
