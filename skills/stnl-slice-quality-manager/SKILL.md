---
name: stnl-slice-quality-manager
description: Delegate independent validation, own formal finding disposition, and terminalize one current-authority slice only on PASS.
---

# stnl-slice-quality-manager

## Purpose

Run only `VALIDATE_SLICE`. Check deterministic prerequisites, delegate technical validation to the configured independent runner, persist its exact result and per-finding dispositions, and complete the slice in the same operation only when it returns `PASS`.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- `SLICE`: required and explicit; normalize one unsigned decimal number to `slice-NN` and never infer it.
- The launcher supplies the platform-specific runner invocation. This skill contains no vendor-specific invocation syntax.

## Authority

The configured independent runner owns the technical verdict. This skill owns Validation Attempts and formal finding disposition in the selected task file and, only after `PASS` prerequisites succeed, the selected row in `tasks.md`. It does not edit requirements, plans, code, tests, or divergences.

## Minimum Reads

- `tasks.md`, selected detailed plan and task file, referenced requirements;
- `references/validation-base.md` before persisting a result;
- local `references/execution-record-schema.md` before interpreting or changing findings, divergences, attempts, or terminal state;
- Implementation Test Evidence and Findings Test Evidence for the selected slice;
- only artifacts needed for cheap prerequisites and faithful persistence.

## VALIDATE_SLICE

Before content reads or delegation, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> VALIDATE_SLICE <SLICE>`. Require all artifacts, matching current requirements fingerprint and plan revision, completed serial dependencies and mandatory checklist, no active blocking divergence, an open non-superseded slice, and valid check/attempt/finding/blocker structure. `IMPLEMENTED_AWAITING_VALIDATION`, `FINDINGS_CORRECTED`, `VALIDATION_BLOCKED`, `IMPLEMENTATION_RETRY_EXHAUSTED`, and `FINDINGS_RETRY_EXHAUSTED` permit this operation. `VALIDATION_NEEDS_FIX` first requires `APPLY_FINDINGS`. The first invocation is `initial`; every later invocation is `revalidation`, including after `BLOCKED`. A terminal `PASS` or `SUPERSEDED` slice is immutable. Block before invoking the runner when any condition fails.

The main context does not rerun tests, redo validation, soften findings, promote `BLOCKED`, or emit another technical verdict.

Prior test evidence is auxiliary, never a formal verdict. Pass it to the runner with the selected diff and scope. The runner independently checks whether the tested file state is still current, the commands were authoritative, selection and coverage remain sufficient, new risks appeared, and prior-slice overlaps require additional regressions. It must independently review a prior `TESTS_NOT_APPLICABLE`: confirm which read-only discovery actions were performed, which discovery sources were consulted, which verification types were considered, and whether any applicable verification command was omitted; reject it when absence of a tool or environment was confused with absence of applicability, and perform proportional static inspection or executable verification when needed. It may reuse current adequate evidence to avoid unjustified repetition, but executes or repeats checks proportionally when state, authority, coverage, or risk requires it. Neither `TESTS_PASS` nor `TESTS_NOT_APPLICABLE` reduces the formal requirements below an independent verdict, creates a Validation Attempt or Effective Validation Base before `VALIDATE_SLICE`, or guarantees `PASS`.

Start validation in a new independent delegated session with no inherited conversation history, using the platform launcher supplied by the caller. Send only operation, `SPEC_PATH`, derived execution root, selected slice, plan/task paths, current requirements fingerprint and plan revision, compact implementation/findings evidence, active and historical finding summary, existing Validation Attempt summary, changed scope and diff, overlaps, and strictly necessary additional context. Never send conversation history or full logs.

Classify initialization/transport failure, valid runner `BLOCKED`, malformed runner output, `NEEDS_FIX`, and verification-command failure separately. For initialization or transport failure only, retry once with a new independent session and the same minimum payload. These technical starts do not create or consume an `attempt-NN`, change `initial` to `revalidation`, or authorize validation in the main context. If both starts fail, persist the canonical active `Delegation Blocker` singleton with `Kind: initialization` and stop in `RUNNER_INITIALIZATION_BLOCKED`. Malformed started output persists it with `Kind: malformed-output` and stops in `RUNNER_RESULT_BLOCKED`. Only the same operation/slice may resume directly at delegation; a later valid attempt resolves the singleton atomically.

For every successfully started runner invocation with a valid result, append exactly one deterministic next `attempt-NN` with type, exact status, HEAD, verified scope, commands and exit codes, evidence, per-finding dispositions, new findings, blockers, unexpected workspace effects, and persistence summary. Preserve every earlier attempt. Formal validation is the only owner of finding state: a valid attempt may resolve fully corrected findings, leave unresolved findings active, supersede a finding with a same-kind finding, and append new stable `finding-NN` records using local `references/execution-record-schema.md`. A valid runner `BLOCKED` is persisted as that attempt and changes no finding state. A malformed response after start is not a transport retry and is persisted once as an objective malformed-result blocker outside Validation Attempts; do not fabricate missing fields.

On `NEEDS_FIX`, validate and persist a complete deterministic disposition for every prior active finding: resolved findings receive a non-placeholder `Resolution` naming this attempt; superseded findings receive `Superseded by: finding-NN`; unresolved problems remain active. Append stable new findings for newly identified implementation problems with severity, state `active`, origin attempt, problem, evidence, impact, related authority, and expected correction. Leave the Effective Validation Base unchanged or absent, keep the global row `[ ]`, leave final result pending, report explicit `APPLY_FINDINGS`, and stop. An authority/scope/strategy gap is instead formal `BLOCKED` with its concrete authority cause in the attempt, followed by its lifecycle handoff when needed and the already-legal `REPLAN` transition; it is never disguised as `NEEDS_FIX` and this skill does not create a divergence.

On `BLOCKED`, persist the concrete cause and missing prerequisite, leave the Effective Validation Base unchanged or absent, keep the global row `[ ]`, do not convert the status, and report a repeat `VALIDATE_SLICE` after its external prerequisite or explicit `REPLAN` when authority is the blocker. Stop.

On `PASS`, in this same operation:

1. validate the current attempt output and the complete final manifest before any mutation;
2. require all original changes, corrections, necessary effects, removals, relevant tests, and prior-slice overlaps, with justified regressions for affected earlier behavior;
3. reject incomplete, malformed, duplicate, unsorted, contradictory, or workspace-inconsistent manifest data and never invent hashes or results;
4. append the current `PASS` attempt without overwriting history;
5. atomically change every remaining applicable active blocking finding to `resolved` with a non-placeholder resolution naming this PASS attempt, or to `superseded` with a valid same-kind pointer; reject PASS if any active blocking finding would remain;
6. create or replace the entire Effective Validation Base so its origin is this current `PASS` attempt;
7. confirm the mandatory checklist, no active blocking finding or divergence, valid hashes, authoritative zero exit codes, and a consistent final result;
8. persist the final diff summary and `PASS` result and change exactly the selected global row from `[ ]` to `[x]` with validation/result `PASS`;
9. stop without selecting another slice.

Compose and validate all detailed/global changes and finding dispositions before publishing them atomically. Never finalize from a historical attempt or accept a base whose origin is `NEEDS_FIX` or `BLOCKED`. A `[x]` `PASS` slice has exactly one valid Effective Validation Base; a `[x]` `SUPERSEDED` slice has no PASS requirement and is immutable; an open slice has `Final Result: pending`.

## Allowed Effects

- obtain at most one valid-result invocation from the configured independent runner, with at most one additional initialization/transport start as specified above;
- update validation-owned sections in `tasks/slice-NN.md`;
- transition finding states only as part of one valid formal attempt;
- update exactly one `tasks.md` row only after valid `PASS` persistence.
- use temporary support files only outside the SPEC and execution root; never create scratch scripts, manifests, checklists, or ad hoc reports inside them.

## Blocks

Block invalid inputs, missing prerequisites, stale requirements authority, invalid attempt/finding history, any active blocking divergence, a non-canonical execution path or unsafe reserved SPEC entry reported by preflight, unavailable runner after the single technical retry, malformed runner output, incomplete Effective Validation Base data, incomplete finding dispositions, overlap without justified regressions, or persistence inconsistency. Arbitrary lifecycle-external or user-owned SPEC-root siblings are allowed and preserved. Never fall back to validation in the main context, delete an unknown path, or allocate an attempt for transport failure.

## Output

Report `PASS`, `NEEDS_FIX`, or `BLOCKED`, persisted evidence paths, whether the slice was completed, and exactly one legally executable next action when non-terminal. Stop.
