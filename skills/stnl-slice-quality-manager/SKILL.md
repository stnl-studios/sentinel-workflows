---
name: stnl-slice-quality-manager
description: Delegate independent validation for one selected slice, persist the exact verdict, and complete it atomically only on PASS.
---

# stnl-slice-quality-manager

## Purpose

Run only `VALIDATE_SLICE`. Check cheap prerequisites, delegate technical validation to the configured `stnl-validation-runner`, persist its exact result, and complete the slice in the same operation only when it returns `PASS`.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- `SLICE`: required and explicit; normalize one unsigned decimal number to `slice-NN` and never infer it.
- The launcher supplies the platform-specific runner invocation. This skill contains no vendor-specific invocation syntax.

## Authority

The independent runner owns the technical verdict. This skill owns persistence in the selected task file and, only after `PASS` prerequisites succeed, the selected row in `tasks.md`. It does not edit requirements, plans, code, or tests.

## Minimum Reads

- `tasks.md`, selected detailed plan and task file, referenced requirements;
- `references/validation-base.md` before persisting a result;
- Implementation Test Evidence and Findings Test Evidence for the selected slice;
- only artifacts needed for cheap prerequisites and faithful persistence.

## VALIDATE_SLICE

Before delegation, require all artifacts, a fully completed mandatory checklist, no known blocking divergence, an open slice, and a valid attempt sequence. The first invocation is `initial`; every later invocation is `revalidation`, including after `BLOCKED`. A concluded slice is immutable. Block before invoking the runner when any condition fails.

The main context does not rerun tests, redo validation, soften findings, promote `BLOCKED`, or emit another technical verdict.

Prior test evidence is auxiliary, never a formal verdict. Pass it to the runner with the selected diff and scope. The runner independently checks whether the tested file state is still current, the commands were authoritative, selection and coverage remain sufficient, new risks appeared, and prior-slice overlaps require additional regressions. It must independently review a prior `TESTS_NOT_APPLICABLE`: confirm which read-only discovery actions were performed, which discovery sources were consulted, which verification types were considered, and whether any applicable verification command was omitted; reject it when absence of a tool or environment was confused with absence of applicability, and perform proportional static inspection or executable verification when needed. It may reuse current adequate evidence to avoid unjustified repetition, but executes or repeats checks proportionally when state, authority, coverage, or risk requires it. Neither `TESTS_PASS` nor `TESTS_NOT_APPLICABLE` reduces the formal requirements below an independent verdict, creates a Validation Attempt or Effective Validation Base before `VALIDATE_SLICE`, or guarantees `PASS`.

For every valid runner invocation, append exactly one deterministic next `attempt-NN` with type, exact status, HEAD, verified scope, commands and exit codes, evidence, findings, blockers, unexpected workspace effects, and persistence summary. Preserve every earlier attempt. If the runner cannot start or returns malformed output after a valid invocation, append `BLOCKED` with that concrete cause and do not fabricate missing fields.

On `NEEDS_FIX`, persist complete compact structured findings, leave the Effective Validation Base unchanged or absent, keep the global row `[ ]`, leave final result pending, and stop. Each finding records problem, evidence, impact, related requirement/plan/task, and expected correction.

On `BLOCKED`, persist the concrete cause and missing prerequisite, leave the Effective Validation Base unchanged or absent, keep the global row `[ ]`, do not convert the status, and stop.

On `PASS`, in this same operation:

1. validate the current attempt output and the complete final manifest before any mutation;
2. require all original changes, corrections, necessary effects, removals, relevant tests, and prior-slice overlaps, with justified regressions for affected earlier behavior;
3. reject incomplete, malformed, duplicate, unsorted, contradictory, or workspace-inconsistent manifest data and never invent hashes or results;
4. append the current `PASS` attempt without overwriting history;
5. create or replace the entire Effective Validation Base so its origin is this current `PASS` attempt;
6. confirm the mandatory checklist, no blocking finding or divergence, valid hashes, authoritative zero exit codes, and a consistent final result;
7. persist the final diff summary and `PASS` result and change exactly the selected global row from `[ ]` to `[x]` with validation/result `PASS`;
8. stop without selecting another slice.

Compose and validate all detailed and global changes before publishing them. Never finalize from a historical attempt or accept a base whose origin is `NEEDS_FIX` or `BLOCKED`. A `[x]` slice has exactly one valid Effective Validation Base; an open slice has `Final Result: pending`.

## Allowed Effects

- invoke the configured independent runner once;
- update validation-owned sections in `tasks/slice-NN.md`;
- update exactly one `tasks.md` row only after valid `PASS` persistence.

## Blocks

Block invalid inputs, missing prerequisites, invalid attempt history, unavailable runner, malformed runner output, incomplete Effective Validation Base data, overlap without justified regressions, or persistence inconsistency. Never fall back to validation in the main context.

## Output

Report `PASS`, `NEEDS_FIX`, or `BLOCKED`, persisted evidence paths, and whether the slice was completed. Stop.
