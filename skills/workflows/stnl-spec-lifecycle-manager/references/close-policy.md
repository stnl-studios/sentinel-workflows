# File Purpose Header

```yaml
purpose: Lossless CLOSE and externals.
status: not_applicable
read_when: CLOSE after readiness.
do_not_read_when: Other modes.
contains: Admission, publication, failures.
owner: stnl-spec-lifecycle-manager
update_policy: CLOSE changes.
```

# CLOSE Policy

CLOSE publishes SPEC_CLOSED, not implementation PASS. Substantive RESUME requires REPLAN. Retire only absent or authenticated COMPLETE execution with ownership; preserve externals.

## Evidence and validation

Reuse authenticated historical PASS criteria/evidence, including last-slice/runbook-linked proof; retain executed/validated/approved milestones. Checklists/PASS labels prove nothing. Coverage needs no extra final test/attestation. Validate authorized changes/impacts in the current slice; file changes alone never reopen prior approvals.

For missing/contradicted proof in a current SPEC, resume saved pending handles first; never repeat uncertain effects. Otherwise automatically delegate the smallest `normalHandoff`: EXECUTE_SLICE/APPLY_FINDINGS to `stnl-slice-executor`, VALIDATE_SLICE to `stnl-slice-quality-manager`. Stay within approved Plan/Tasks, checks and budgets; use the controller, independent runner and formal publication. Preserve history; no invented authority, predecessor reopening, REPLAN or RECONCILE.

Reinspect each step. Close only authenticated COMPLETE with all criteria proved and ownership settled. Corruption, uncertainty, blockers or no legal handoff stop CLOSE. Never retry an exhausted operation. No budget resets or legacy reconstruction. Absent execution permits documentary close, never implementation PASS.

## Publication

CLOSE requires active ready.

Run `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" CLOSE <TARGET>` without candidate; runtime derives disposition and renders in its owned stage. Preview grants no authority. Common lease precedes lifecycle lease; recheck source identity/digest, execution authority/activation/manifest and rendered bytes before promotion. Pending/uncertain/foreign producers block discard. Retain source/backup and recovery authority until commit/settlement; remove only bound roles before empty namespace/lease. Partial integration cannot authorize discard. Never model-rebuild output.

## Consolidation and boundaries

Copy Objective, Context, Scope→Final Scope, Out of Scope, Business Rules and Relevant Contracts→Important Contracts unchanged; derived requirements become canonical R bytes. Optional categories require materialized records. Preserve IDs/types/titles/status, metadata order, narrative/relations, tombstones/reasons, final Q, Unicode/gaps. No invented evidence, summaries, timestamps or nondeterminism. Reject missing/extra/changed records, duplicate authority, open questions, malformed output or changed externals. Repeated renders must match exactly.

shared/ disappears only in the validated candidate; execution/ only after admission and retirement checks. Copy other externals without dereferencing links; OS packaging metadata grants no authority and is not copied. Failure preserves source; recovery owns cleanup. Never manually remove shared/, backups or foreign replacements.

Darwin symlink hardlink groups use fixed `/bin/ln -P -h --`, no shell, 2-second/4-KiB limits; other links use Node. Preserve literal targets, even dangling/absolute. Require names inside sealed stage/filesystem and absent destination; verify identity, parents, payload, inode/link topology before/after. Failure blocks retries/alternates; preserve foreign material. Syscall-time hostile mutation remains possible.

## History

Archive the final execution snapshot and committed same-SPEC native sources byte-for-byte before retirement. Bound hash/identity guards recovery. Foreign/uncertain sources block. Archives grant no live PASS.

Report historicalArchive; preserve history and unbound archives. Recovery uses only its bound archive.

## Results

Report publication, cleanup complete|pending, transaction, authority, digest and disposition. Failed parent fsync after final unlink means FINAL_SETTLEMENT_DURABILITY_UNCONFIRMED/cleanup pending: never recreate locks/names. Recovery controls authorize cleanup only; absent controls never authorize republishing.

After retirement: SPEC_CLOSED/no execution handoff; lifecycle NOT_APPLICABLE. Unproved roadmap dependencies stay UNKNOWN. Runbook cannot reconstruct approval.
