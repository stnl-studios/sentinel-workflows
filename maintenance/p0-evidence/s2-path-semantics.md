# S2 Path Semantics Hardening

Base SHA: `82b56e0c4bd5acd444ecfcd47f6409720c8d5488`

Resulting commit: pending user commit

Status: `PATCH_READY_FOR_COMMIT`

## Problem Corrected

PLAN/TASKS implementation path claims could retain the wrong relative basis through candidate validation and reach `MATERIALIZED_PRISTINE`. The runtime now identifies explicitly delimited claims in global `Expected areas`, detailed `Likely Areas`, and detailed-task checklist `expected areas`.

## Invariants Added

- Resolve every implementation path claim from its containing logical artifact.
- Reject absolute and non-canonical claims without rewriting them.
- Reject trusted-root escape and symlink traversal.
- Reject targets inside the execution root.
- In a nested Git lifecycle workspace, reject accidental targets inside the lifecycle SPEC.
- Accept existing targets and safe future targets with safe existing ancestors.
- Diagnose an absent standalone target when the same project-root target makes a path-basis error evident.
- Keep candidate validation isolated from live execution and requirements bytes.

## Functional Files Modified

- `scripts/test-execution-contract.mjs`
- `skills/workflows/stnl-execution-planner/SKILL.md`
- `skills/workflows/stnl-execution-planner/references/workspace.md`
- `skills/workflows/stnl-execution-planner/templates/plan.template.md`
- `skills/workflows/stnl-execution-planner/templates/slice-plan.template.md`
- `skills/workflows/stnl-plan-reviewer/SKILL.md`
- `skills/workflows/stnl-task-materializer/SKILL.md`
- `skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md`
- `skills/workflows/stnl-task-reviewer/SKILL.md`
- Eight active `runtime/execution-state.mjs` copies under the execution workflow skills.

## Test Cases Added

- Lifecycle global plan path resolving inside execution root: reject.
- Lifecycle detailed plan path resolving inside the SPEC workspace: reject.
- Detailed task expected area resolving inside the SPEC workspace: reject.
- Correct existing artifact-relative paths: pass.
- Correct future project target with a safe existing ancestor: pass.
- Short future path inside the lifecycle SPEC: reject.
- Nested standalone correct local and project paths: pass.
- Nested standalone path-basis mismatch with an existing project target: reject without fallback.
- Spaces and Unicode in roots and targets: pass.
- Candidate rejection preserves live planning, task, and requirements bytes.
- Absolute, trusted-root escape, and symlink traversal: reject.
- REVIEW_PLAN and REVIEW_TASKS can read correctable live drafts; candidates remain strict.
- MATERIALIZE_TASKS and EXECUTE_SLICE preflights reject invalid persisted claims.

## Checks

| Command | Exit | Result |
| --- | ---: | --- |
| `node --test scripts/test-execution-contract.mjs` (baseline) | 0 | 89/89 passed |
| `node scripts/check-contracts.mjs repository --root .` (baseline) | 0 | PASS |
| `bash scripts/validate.sh --no-smoke` (baseline) | 0 | PASS |
| `node --test --test-name-pattern='artifact-relative planning paths\|materialization and task-review gates\|standalone path basis' scripts/test-execution-contract.mjs` | 0 | 3/3 passed |
| `node --test scripts/test-execution-contract.mjs` | 0 | 92/92 passed |
| `node scripts/check-contracts.mjs repository --root .` | 0 | PASS |
| `git diff --check` | 0 | PASS |
| `bash scripts/validate.sh --no-smoke` | 0 | PASS |

Full smoke was not run because the focused contract suite plus `validate.sh --no-smoke` cover the changed runtime, templates, skills, and repository contracts.

## Runtime Copies

- Count: 8
- SHA-256: `d4fd351674eb87b044fec9df632d4043dc8aa4ce33434b664b742fbae8aa80e0`
- Equivalence: byte-identical

## Reviewer

Final read-only reviewer: PASS

Findings: none.

## Limitations

- Only filesystem claims explicitly delimited with Markdown code spans in the three implementation-area carriers are validated; conceptual text remains prose.
- No model qualification was rerun.
- G5 was not promoted.
