# File Purpose Header

```yaml
purpose: Define operational task-record schemas that must never appear in a freshly materialized pristine task.
status: not_applicable
read_when: EXECUTE_SLICE, APPLY_FINDINGS, VALIDATE_SLICE, REPLAN materialization, or CLOSE persists or interprets operational records.
do_not_read_when: Only a pristine task is being rendered or reviewed.
contains: Check evidence, findings, divergences, attempts, supersession, effective validation base, and lifecycle transitions.
owner: stnl-task-materializer
update_policy: Change only when persisted execution-record identity or lifecycle semantics change.
```

# Execution Record Schema

Fresh materialization contains only its exact section sentinels (`- none` or `- pending`). The headings below are operational records, never template examples and never pristine placeholders.

## Changed and corrected paths

After work starts, `Changed Areas` replaces `- pending` with a non-empty lexicographically ordered list of unique normalized task-relative paths, each exactly `- \`<path>\``. `Corrections Applied` remains `- none` or uses the same list format. Every corrected path must also occur in `Changed Areas`. Nested bullets, prose, absolute paths, backslashes, duplicate paths, and unnormalized paths are invalid. `REMOVED` versus SHA-256 ownership is recorded in the Effective Validation Base; these sections claim the affected path without duplicating that disposition.

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

Every valid formal `VALIDATE_SLICE` attempt owns deterministic per-finding dispositions. A `NEEDS_FIX` attempt may resolve fully corrected prior findings, supersede a finding with a new same-kind finding, leave still-failing findings active, and append new active findings. A current `PASS` must atomically resolve or supersede every remaining active blocking finding before completion. Each resolution names the owning formal attempt. `APPLY_FINDINGS`, partial correction, and auxiliary checks never resolve or supersede findings.

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
- HEAD, tested scope, complete tested state hashes/removals;
- check discovery sources and relevant read-only discovery actions;
- verification types considered and exact commands with numeric exits;
- non-applicability rationale and no-command confirmation when applicable;
- selected checks, rationale, coverage, failures, blockers, unexpected effects, and persistence summary;
- prior-round failure, correction, files, and updated in-slice rationale when applicable;
- for findings checks, finding cycle/IDs, findings verified, corrections covered, regressions, and unsupported active findings.

The exact mandatory fields are `Automatic check round`, `Status`, `HEAD`, `Tested scope`, a non-empty `Tested state` path/hash-or-removal list, `Discovery sources`, `Discovery actions`, `Verification types considered`, `Commands`, `Selected checks`, `Selection rationale`, `Coverage`, `Failures`, `Blockers`, `Unexpected workspace effects`, and `Persistence summary`. `Commands` contains exact backticked commands with numeric exits; only `TESTS_NOT_APPLICABLE` or `BLOCKED` may use the exact scalar `none`. Round 2 or 3 additionally requires non-placeholder `Prior-round failure`, `Correction applied`, `Correction paths`, `Updated scope`, and `In-slice rationale`. A findings check additionally requires `Findings cycle`, `Finding IDs`, `Findings verified`, `Corrections covered`, `Regressions`, and `Unsupported active findings`. Its cycle names the latest applicable existing `NEEDS_FIX` attempt. A trailing round 1 or 2 `TESTS_FAIL` is invalid unless an active blocking divergence explains why the authorized automatic correction cycle stopped.

A round `3/3 TESTS_FAIL` persists normally and enters `IMPLEMENTATION_RETRY_EXHAUSTED` or `FINDINGS_RETRY_EXHAUSTED`. The executor cannot re-enter either operation until explicit `VALIDATE_SLICE` records the next formal verdict.

## Validation Attempts

Every successfully started formal validation with valid output appends the next `attempt-NN`. `attempt-01` is `initial`; later attempts are `revalidation`. Each records exact status `PASS|NEEDS_FIX|BLOCKED`, HEAD, verified scope, commands and exits, evidence, finding references, blockers, unexpected effects, and persistence summary. Transport and malformed-output blockers remain outside attempts under their singleton contracts.

The exact mandatory attempt fields are `Type`, `Status`, `HEAD`, `Verified scope`, `Commands`, `Evidence`, `Finding references`, `Finding dispositions`, `Blockers`, `Unexpected workspace effects`, and `Persistence summary`. Commands have numeric exits; only `BLOCKED` may use exact `none`. A finding `Origin` names an existing `NEEDS_FIX` attempt. A resolved finding's `Resolution` names an existing same-or-later `NEEDS_FIX` or `PASS` attempt. A superseded finding/divergence points strictly forward to a later same-kind identifier; backward pointers and cycles are invalid.

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

## Superseded slice terminal record

Only append-only approved-replan materialization writes this terminal result for an open slice:

```markdown
## Final Result

- SUPERSEDED
- Superseded by: slice-NN
- Plan revision: <positive integer>
```

The matching global row is `[x]` with Validation and Result `SUPERSEDED`. This preserves history and satisfies serial progress without claiming a validation `PASS`. A historical `PASS` is never changed to `SUPERSEDED`.
