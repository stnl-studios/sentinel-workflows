---
name: stnl-execution-planner
description: Create a compact global execution plan and every foreseeable detailed slice plan from an authoritative requirements source.
---

# stnl-execution-planner

## Purpose

Run only `PLAN`. Convert an authoritative requirements source into a strictly serial delivery strategy without creating tasks, implementing, testing authoritatively, or approving the result.

## Inputs

- `SPEC_PATH`: required. Normalize it with `references/workspace.md`.
- Optional additional context may narrow this operation but cannot change requirements, scope, dependencies, or authority.

## Authority

The normalized requirements source remains authoritative and unchanged. This skill may create only `plan.md` and `plans/slice-NN.md` below the derived execution root. Persist every path relative to the artifact containing it.

## PLAN

Derive the execution-root state before any write. Ignore `__MACOSX`, `.DS_Store`, and `._*` when deciding whether a directory is empty. `PLAN` is allowed only when the root is absent or contains no other entries. If any recognized planning or execution artifact exists, return `BLOCKED`, list it, preserve every byte, and name the operation compatible with the observed state. Unrelated content is also a collision and blocks. Reset is a separate explicit user action outside this workflow.

Read `references/workspace.md`, the requirements needed for coverage, shallow project structure, and only code or tests directly needed to understand impact. Define observable, testable slices in strict serial order. Record explicit dependencies, requirement coverage, included and excluded scope, boundaries, risks, likely areas, expected tests, and integration needs. Avoid microtasks and broad slices.

If several slices require real integration verification, add a final explicit integration or stabilization slice. Do not defer that verification to closing.

Create `plan.md` and every foreseeable `plans/slice-NN.md` using the templates. Set each File Purpose Header status to `draft`; this means planning exists but independent review has not approved it.

## Minimum Reads

- `references/workspace.md`;
- normalized requirements source and directly referenced requirement records;
- `templates/plan.template.md` and `templates/slice-plan.template.md` when writing artifacts;
- shallow structure and directly relevant implementation areas only.

## Allowed Effects

- create the derived execution root when safe;
- create `plan.md` and the complete `plans/slice-NN.md` set once, only from the `empty` state;
- report coverage and concrete uncertainty.

## Blocks

Block without writes when `SPEC_PATH` is invalid, the execution root is not `empty`, requirements are insufficient for deterministic planning, or a product decision is required. Return the ambiguity to the requirements owner; do not invent an answer or reset existing artifacts.

## Output

Report created paths, slice order, coverage, material risks, and that `REVIEW_PLAN` is required. Stop after `PLAN`.
