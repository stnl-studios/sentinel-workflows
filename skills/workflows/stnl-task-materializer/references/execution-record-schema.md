# File Purpose Header

```yaml
purpose: Define operational task-record schemas that must never appear in a freshly materialized pristine task.
status: not_applicable
read_when: EXECUTE_SLICE, APPLY_FINDINGS, VALIDATE_SLICE, REPLAN materialization, or terminal runtime inspection interprets operational records.
do_not_read_when: Only a pristine task is being rendered or reviewed.
contains: Check evidence, findings, divergences, attempts, supersession, effective validation base, and lifecycle transitions.
owner: stnl-task-materializer
update_policy: Change only when persisted execution-record identity or lifecycle semantics change.
```

# Execution Record Schema

Fresh materialization contains only its exact section sentinels (`- none` or `- pending`). The headings below are operational records, never template examples and never pristine placeholders.

## Strict write check and exact contract repair

The parser accepts only canonical `Finding IDs`, `Discovery sources`, and `Discovery actions`. The model-authored execution-record writer contract requires an isolated candidate and the bundled `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>` before publication. That invocation and mutation ownership are contract/model enforced; when invoked, the runtime strictly parses the complete candidate without changing live execution. It is not a generic publisher and does not prove an authorized diff.

Every preflight is read-only. When its structured violation identifies either exact `Findings IDs` or the exact historical pair `Check discovery sources` / `Check discovery actions`, no canonical field coexists, every required legacy field occurs once with a non-empty value, and any finding IDs pass the current grammar and membership rules, the caller may explicitly run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --repair-known-contract`. The runtime collects every approved occurrence in that one task artifact and changes only approved labels in a complete isolated candidate. Publication acquires a repair-local exclusive lock, revalidates source identity and bytes, claims the source into an owned backup, installs the candidate with no-replace semantics, strictly reads it back, and rolls back only while the live publication is still repair-owned. A concurrent source or lock replacement aborts without overwriting or removing foreign bytes. If another task artifact also requires repair, the operation blocks because multi-file replacement is not authorized. Duplicates, coexistence, incomplete pairs, unknown labels, undeclared/invalid values, or any other invalidity remain blocked. Repair changes no value, semantic record, owner, attempt, round, validation base, runner budget, product code, or test result; it is not a generic publisher.

Only complete historical producer signatures receive legacy classification. The exact `e45e41d` split-plan producer requires its historical File Purpose Header values plus exact primary H1, ordered sections, authority-field layout, and canonical table shape; it predates `Requirements authority` and `Plan revision` and is semantically incomplete. The exact `98545e4` lifecycle-root phase generation, identified by its historical owners, primary H1s, sections, tables, filenames, and paired details, is structurally incompatible. Both remain blocked because the runtime cannot invent authority or migrate history. An old H1 in prose/fenced text, missing current authority fields, a hybrid structure, or editorial `tasks.md` prose is a current parse concern, never a historical signature. No broad migration is attempted.

## Changed and corrected paths

After work starts, `Changed Areas` replaces `- pending` with a non-empty lexicographically ordered list of unique normalized task-relative paths, each exactly `- \`<path>\``. The only exception is exact `- none` when the current state-driving auxiliary check uses `Tested state: none` plus objective `Fileless reason`, and later for its terminal fileless PASS whose Effective Validation Base uses `Files: none` with an objective `Fileless reason`; it never authorizes an invented path. Current file-backed evidence requires paths, while older fileless/file-backed rounds remain valid when the current authority is coherent. `Corrections Applied` remains `- none` or uses the same list format; fileless APPLY_FINDINGS may keep exact `- none` with objective correction evidence. Every file-backed corrected path must also occur in `Changed Areas`. Nested bullets, prose, absolute paths, backslashes, duplicate paths, and unnormalized paths are invalid. `REMOVED` versus SHA-256 ownership is recorded in the Effective Validation Base; these sections claim the affected path without duplicating that disposition.

## Findings and divergences

Identifiers are append-only and sequential within their section. Never reuse, renumber, remove, or mutate the identity or origin of a historical record.

```markdown
### finding-NN

- Severity: blocking|advisory
- State: active|resolved|superseded
- Origin: <operation/attempt>
- Problem: <compact problem>
- Evidence: <compact objective evidence>
- Impact: <requirement or behavior impact>
- Related authority: <requirement/plan/task references>
- Expected correction: <objective correction>
```

```markdown
### divergence-NN

- Severity: blocking|advisory
- State: active|resolved|superseded
- Origin: <operation/attempt>
- Problem: <compact authority/scope/strategy divergence>
- Evidence: <compact objective evidence>
- Required authority operation: <RESUME or REPLAN>
```

An active record omits both disposition fields. A resolved record adds only `- Resolution: <non-placeholder resolution>`. A superseded record adds only `- Superseded by: <strictly later same-kind identifier>`.

Every finding created by a `NEEDS_FIX` attempt is born `active`. Every valid later formal `VALIDATE_SLICE` attempt owns deterministic per-finding dispositions. A later `NEEDS_FIX` attempt may resolve fully corrected prior findings, supersede a finding with a new same-kind finding whose origin is strictly later, leave still-failing findings active, and append new active findings. A current `PASS` must atomically resolve or supersede every remaining active blocking finding before completion. Each resolution names a formal attempt strictly later than the origin. `APPLY_FINDINGS`, partial correction, and auxiliary checks never resolve or supersede findings.

Only the atomic `MATERIALIZE_TASKS` commit of an approved `REPLAN` may change applicable active divergences to `resolved` or `superseded`. A resolved blocking divergence uses exactly `- Resolution: plan revision <positive integer> committed recovery slice-NN`; that revision and slice must be the committed supersession owner. Supersession points to a new divergence of the same kind. Lifecycle `RESUME` may correct documentary authority but never mutates execution records; `REPLAN` reconciles that corrected authority and owns the execution transition.

Only records with `Severity: blocking` and `State: active` block execution, formal validation, completion, or execution close. Resolved and superseded records remain auditable history.

On a terminal `SUPERSEDED` slice, unresolved records remain preserved historical context but no longer block the replacement slice or execution close. Its required later `PASS` owner is the effective authority.

## Delegation blocker singleton

Fresh materialization persists only `- none` under `## Delegation Blocker`. A definitive transport/initialization failure after the bounded technical retry or one malformed started-runner result replaces that sentinel with exactly one singleton:

```markdown
- Operation: EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE
- Kind: initialization|malformed-output
- State: active
- After record: none|implementation-check-NN|findings-check-NN|attempt-NN
- Causes:
  - <objective compact cause>
- Required action: <objective executable recovery>
```

`After record` is the latest valid record for the named operation when the blocker was persisted. Only the same operation on the same slice may resume directly at delegation. A later valid operation record atomically changes the singleton to `State: resolved` and adds `- Resolution: <objective result naming that later record>`. `Resolution` is forbidden while active and mandatory while resolved. A resolved singleton remains historical. It is invalid to keep the blocker active after a later valid record or to mark it resolved without one.

## Auxiliary check evidence

Each record uses the next section-global identifier, `implementation-check-NN` or `findings-check-NN`, and includes:

- automatic round `1/3`, `2/3`, or `3/3` for the current manual operation;
- status `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE`, or `BLOCKED`;
- HEAD, tested scope, complete tested state hashes/removals, or exact `Tested state: none` plus an objective `Fileless reason`;
- canonical discovery sources and relevant read-only discovery actions;
- verification types considered and exact commands with numeric exits;
- non-applicability rationale and no-command confirmation when applicable;
- selected checks, rationale, coverage, failures, blockers, unexpected effects, and persistence summary;
- prior-round failure, correction, files, and updated in-slice rationale when applicable;
- for findings checks, finding cycle/IDs, findings verified, corrections covered, regressions, and unsupported active findings.

The exact mandatory fields are `Automatic check round`, `Status`, `HEAD`, `Tested scope`, `Tested state`, `Discovery sources`, `Discovery actions`, `Verification types considered`, `Commands`, `Selected checks`, `Selection rationale`, `Coverage`, `Failures`, `Blockers`, `Unexpected workspace effects`, and `Persistence summary`. Scalar summaries are compact opaque inline values with no nested list. In `TESTS_PASS`, exact `none` is forbidden specifically for `Tested scope`, `Verification types considered`, `Selected checks`, and `Coverage`; it remains legitimate in fields such as zero blockers or unexpected effects. `Commands` and file-backed `Tested state` are the only structured nested fields in an auxiliary record. `Commands` contains exact backticked commands with numeric exits; only `TESTS_NOT_APPLICABLE` or `BLOCKED` may use exact scalar `none`. File-backed `Tested state` paths are normalized task-relative, unique, lexicographically ordered, and paired with lowercase SHA-256 or `REMOVED`. A fileless record instead uses exact `Tested state: none` and exactly one non-placeholder inline `Fileless reason`; the field is forbidden for file-backed state. Round 2 or 3 additionally requires non-placeholder `Prior-round failure`, `Correction applied`, `Updated scope`, and `In-slice rationale`; file-backed `Correction paths` is an exact comma-space-delimited normalized ordered set, while exact `none` is permitted only for the corresponding fileless correction. A findings check additionally requires `Findings cycle`, `Finding IDs`, `Findings verified`, `Corrections covered`, `Regressions`, and `Unsupported active findings`. `Finding IDs` is one non-empty lexicographically ordered set and is the canonical target set. `Findings verified` is exact `none` or a canonical subset of `Finding IDs`. `Unsupported active findings` is deterministically every active finding at the named cycle not present in `Findings verified`; verified and unsupported never overlap. Membership, declaration, ordering, and cycle checks remain strict. A trailing round 1 or 2 `TESTS_FAIL` is invalid unless an active blocking divergence explains why the authorized automatic correction cycle stopped.

For `EXECUTE_SLICE`, every mandatory checklist item and related execution state is persisted in the same isolated task candidate before a terminal implementation record (`TESTS_PASS`, `TESTS_NOT_APPLICABLE`, or round `3/3 TESTS_FAIL`) may be added. Candidate validation rejects terminal implementation evidence with an incomplete checklist. A pre-existing live inconsistency is not treated as generic corruption or routed through `REPLAN`: the runtime preserves its observed state but exposes exactly one mandatory target, `stnl-slice-executor / EXECUTE_SLICE / <affected slice>`, with the terminal record and round. That recovery may only make the approved execution/checklist record complete, preserves terminal evidence and formal history, is repeatable before publication, and publishes the complete task artifact once. After completion, normal validation or retry-exhaustion authority resumes. A complete `IMPLEMENTED_AWAITING_VALIDATION` task never reopens execution.

A round `3/3 TESTS_FAIL` persists normally and enters `IMPLEMENTATION_RETRY_EXHAUSTED` or `FINDINGS_RETRY_EXHAUSTED`. The executor cannot re-enter either operation until explicit `VALIDATE_SLICE` records the next formal verdict, except for the exact same-slice incomplete-implementation recovery above.

## Validation Attempts

Every successfully started formal validation with valid output appends the next `attempt-NN`. `attempt-01` is `initial`; later attempts are `revalidation`. Each records exact status `PASS|NEEDS_FIX|BLOCKED`, HEAD, verified scope, commands and exits, evidence, finding references, blockers, unexpected effects, and persistence summary. Transport and malformed-output blockers remain outside attempts under their singleton contracts.

The exact mandatory attempt fields are `Type`, `Status`, `HEAD`, `Verified scope`, `Commands`, `Evidence`, `Finding references`, `Finding dispositions`, `Blockers`, `Unexpected workspace effects`, and `Persistence summary`. Scalar summaries stay inline and opaque. Commands have numeric exits and remain structurally scoped to `Commands`; only `BLOCKED` may use exact `none`. `Finding references` uses exact `none` or `finding-NN, finding-NN`. `Finding dispositions` uses exact `none` or `finding-NN=active|resolved|superseded, finding-NN=active|resolved|superseded`. Both use unique lexicographically ordered canonical IDs with identical identifier sets, and every attempt disposes every finding whose origin is at or before that attempt according to the deterministic timeline. A finding `Origin` names an existing `NEEDS_FIX` attempt. Resolution and supersession authority is strictly later than that origin. The first `PASS` attempt is terminal: no later `PASS`, `NEEDS_FIX`, `BLOCKED`, or other `attempt-NN` may exist. Prior `NEEDS_FIX` history and the final owning PASS remain valid.

## Effective Validation Base

At most one current base exists and it originates from the current `PASS` attempt:

```markdown
- Origin attempt: attempt-NN
- Attempt type: initial|revalidation
- HEAD: <commit or not_available>
- Result: PASS
- Files:
  - `<relative/path>` | sha256:<64 lowercase hexadecimal characters>
  - `<removed/relative/path>` | REMOVED
- Authoritative commands:
  - `<exact command>` | exit:<integer>
- Evidence summary: <compact evidence>
```

A valid fileless PASS uses the same record with exact `- Files: none`, followed immediately by `- Fileless reason: <objective non-placeholder reason>`. It keeps authoritative commands and the owning attempt's exact evidence summary. A file-backed base forbids `Fileless reason`; a fileless base forbids path/hash tuples and requires `Changed Areas` to be exact `- none`.

## Superseded slice terminal record

Only append-only approved-replan materialization writes this terminal result for an open slice:

```markdown
## Final Result

- SUPERSEDED
- Superseded by: slice-NN
- Plan revision: <positive integer>
```

The matching global row is `[x]` with Validation and Result `SUPERSEDED`. This preserves history and satisfies serial progress without claiming a validation `PASS`. A historical `PASS` is never changed to `SUPERSEDED`.
