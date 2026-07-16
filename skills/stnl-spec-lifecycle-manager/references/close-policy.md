# File Purpose Header

```yaml
purpose: Define strict authority equivalence, no-invention closure, and protected external boundaries.
status: not_applicable
read_when: MODE is CLOSE or final one-file consolidation is requested.
do_not_read_when: The SPEC remains active or any documentary blocker is unresolved.
contains: Documentary preconditions, exact canonical equivalence, candidate consolidation, and publication checks.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when documentary closure or preservation policy changes.
```

# CLOSE Policy

Require explicit `MODE=CLOSE`. Closure validates documentary authority, never implementation. The source must be an active `ready` workspace that passes global readiness again: no open blocking question, active `blocked_by`, computed broken reference, material conflict, uncovered in-scope requirement, or blocking documentary gap. Every Q must already be `resolved`, `bypassed`, or `dropped`; resolve documentary state through RESUME, never during CLOSE.

## Exact consolidation

Consolidate the existing Objective; Context; Final Scope; Out of Scope; canonical Requirements; Business Rules; Final Acceptance Criteria; Durable Decisions; Relevant Constraints; Relevant Risks; Important Contracts; and all final Q records under Durable Resolved Questions. The active feature's derived requirement list is replaced by its canonical R records, not copied as a second authority.

Preserve the feature H1 identity. The closed canonical ID set must exactly equal the source set. For every record, preserve prefix/type, ID, title, status, ordered metadata, narrative, and record identity; only its owning closed section changes. Reject missing or extra records, new IDs or titles, type changes, rewritten content, duplicated authority, or invented requirements, decisions, criteria, constraints, risks, questions, contracts, answers, or justifications. At a valid close source, ACs already have no `blocked_by` and final questions have no `blocks`, so CLOSE performs no semantic cleanup.

Preserve every final Q record. Do not infer that an answer was probably incorporated elsewhere. Never add session logs, internal reasoning, command output, operational records, diffs, tests, commits, or implementation evidence to the closed SPEC.

## Candidate and publication

Follow the safe-publication protocol in `modes.md`. Build the complete one-file result in an isolated candidate while live `shared/` remains untouched. Validate the candidate structure, exact source-to-result authority equivalence, allowed section relocation, and the external snapshot before publication. Only then publish the final `feature_spec.md` and remove lifecycle-owned `shared/` as one rollback-capable transition. Validate the live closed form and external snapshot again.

Any failure leaves the active source intact; never remove live `shared/` before the candidate and transition pass.

## External boundary

CLOSE must not alter, remove, or move `execution/` or any other directory not owned by the documentary lifecycle. It must not use code, tests, tasks, commits, diffs, or delivery state as a closure gate. External contents may be compared for preservation but are not documentary input.
