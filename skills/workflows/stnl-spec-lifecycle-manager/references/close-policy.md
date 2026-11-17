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

CLOSE publishes SPEC_CLOSED, not implementation approval. Substantive RESUME requires REPLAN. Retire execution only if absent or authenticated COMPLETE with ownership; preserve other externals.

## Evidence and validation

Inspect execution. Reuse authenticated historical PASS criteria/evidence, including last-slice or runbook-linked proof; retain executed/validated/approved milestones. Runbook instructions/checklists or PASS labels alone prove nothing. Sufficient coverage needs no generic final test/terminal attestation. Validate authorized changes/impacts in the current slice; file changes alone never reopen prior approvals.

Missing coverage or concrete contradiction: automatically delegate the exact current `VALIDATE_SLICE` handoff to `stnl-slice-quality-manager` with affected criteria/evidence, preserving approved scope/checks. Use its controller, independent runner and formal publication; never fabricate evidence, owner or earlier-slice selection, replan or RECONCILE.

Reinspect; publish only authenticated COMPLETE with all closure criteria proved and ownership resolved. Failure, uncertainty, prerequisites or no legal handoff block CLOSE; preserve execution and report. No unchanged retries, implementation or automatic fixes. Absent execution permits documentary close, never implementation PASS.

## Publication

Explicit CLOSE requires active ready.

Run `node "<SKILL_ROOT>/runtime/publish-spec-lifecycle.mjs" CLOSE <TARGET>` without candidate; runtime derives disposition and renders in its owned stage. Preview grants no authority. Common lease precedes lifecycle lease; recheck source identity/digest, execution authority/activation/manifest and rendered bytes before promotion. Pending/uncertain/foreign producers block discard. Retain source/backup and recovery authority until commit/settlement; remove only bound roles before empty namespace/lease. Partial integration cannot authorize discard. Never model-rebuild output.

## Consolidation and boundaries

Copy Objective, Context, Scope→Final Scope, Out of Scope, Business Rules and Relevant Contracts→Important Contracts unchanged; derived requirements become canonical R bytes. Optional categories require materialized records. Preserve IDs/types/titles/status, metadata order, narrative/relations, tombstones/reasons, final Q, Unicode/gaps. No invented evidence, summaries, timestamps or nondeterminism. Reject missing/extra/changed records, duplicate authority, open questions, malformed output or changed externals. Repeated renders must match exactly.

shared/ disappears only in the validated candidate; execution/ only after admission and retirement checks. Copy other externals without dereferencing links; OS packaging metadata grants no authority and is not copied. Failure preserves source; recovery owns cleanup. Never manually remove shared/, backups or foreign replacements.

Darwin symlink hardlink groups use fixed `/bin/ln -P -h --`, no shell, 2-second/4-KiB limits; other links use Node. Preserve literal targets, even dangling/absolute. Require names inside sealed stage/filesystem and absent destination; verify identity, parents, payload, inode/link topology before/after. Failure blocks retries/alternates; preserve foreign material. Syscall-time hostile mutation remains possible.

## History

Archive the final execution snapshot and committed same-SPEC native sources byte-for-byte before retirement. Bound hash/identity guards recovery. Foreign/uncertain sources block. Archives grant no live PASS.

Report historicalArchive; retain history. Never adopt/delete unbound archives. Recovery reuses only its bound archive.

## Results

Report publication, cleanup complete|pending, transaction, authority, digest and disposition. Failed parent fsync after final unlink means FINAL_SETTLEMENT_DURABILITY_UNCONFIRMED/cleanup pending: never recreate locks/names. Recovery controls authorize cleanup only; absent controls never authorize republishing.

After retirement: SPEC_CLOSED/no execution handoff; lifecycle NOT_APPLICABLE. Unproved roadmap dependencies stay UNKNOWN. Runbook cannot reconstruct approval.
