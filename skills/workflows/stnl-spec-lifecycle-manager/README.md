# stnl-spec-lifecycle-manager

This self-contained package maintains independent documentary feature SPECs through `INIT`, `RESUME`, `READINESS`, and `CLOSE`. It does not plan or execute implementation work.

## Installation and runtime

Copy only this directory. At use time, derive `<SKILL_ROOT>` from the directory containing the loaded `SKILL.md`; neither the current process directory nor a platform-specific skill location is authoritative. The operational entrypoints are:

- `runtime/validate-spec-lifecycle.mjs`
- `runtime/create-resume-manifest.mjs` (RESUME-only manifest scaffold)
- `runtime/create-readiness-attestation.mjs`
- `runtime/build-closed-spec.mjs`
- `runtime/publish-spec-lifecycle.mjs`
- `runtime/prepare-init-candidate.mjs` (INIT-only prevalidation owner serialization)

Invoke them directly with `node "<SKILL_ROOT>/runtime/<entrypoint>.mjs" ...`. They use only native Node modules and require no package manager, build, repository-relative resource, environment convention, or external executable. Runtime source is executed, not loaded into the model's normal context; `SKILL.md` and the selected references retain progressive disclosure.

## Documentary contracts

An active workspace owns `feature_spec.md` plus materialized categories in `shared/`. Canonical headings are the sole ID authority, metadata is an ordered Markdown list, records retire in place, and structural relationships remain bidirectionally validated. `READINESS` is read-only. Semantic `GLOBAL/READY` over current `ready` state creates an external attestation directly. When the validated state is still `draft`, an authorized status-only `RESUME` passes the deterministic sibling attestation path instead of a manifest; the publisher validates the `ready` candidate and materializes the attestation bound to that exact snapshot before promotion. `CLOSE` requires that current attestation, renders exact canonical bytes, validates the transition, and publishes without model-authored consolidation.

## Publication and recovery

The publisher stages a complete disjoint candidate, validates its captured digest, journals every transactional phase, renames the source to a transaction-owned backup, verifies that backup, promotes the stage, revalidates the official path, and removes transaction residue only after commit. Journal schema version 2 preserves exactly ten fields: version, mode, target/stage/backup names, phase, source/candidate/observed digests, and transaction identity. A strict sibling ownership sidecar, `.<workspace-name>.lifecycle-ownership-<transaction-id>.json`, binds that transaction to the persisted device/inode identities and digests of its stage, source, backup, and promoted target. Recovery runs under the lock before new work and either completes a verified commit or restores and validates the exact captured source. Corrupt, foreign, or inconsistent metadata is preserved and rejected rather than treated as deletion authority.

On Windows, only actual rename syscall arguments are converted with Node's native namespaced-path API. Rename retries are limited to three total attempts with deterministic short backoff, and only `EPERM`, `EACCES`, or `EBUSY` is retryable. Staging remains beside the target on the same volume; validation is not repeated by the retry, persisted paths and diagnostics remain portable, and other platforms retain their single native rename behavior.

The sibling `.<workspace-name>.lifecycle.lock` is strict JSON in a single-link regular file. Acquisition writes and synchronizes a private build, atomically exposes a complete claim through the native hardlink primitive, settles the claim to one canonical link, and fails safely when the filesystem cannot provide that primitive. Version 2 adds the closed `common_lease` witness to the existing owner/operation/transaction, process ID, host, state and start time. The producer derives this witness from its real common lease before allocating a transaction: canonical execution/lock paths, stable parent and lock device/inode identities, token, exact byte digest, PID and producing host. Lifecycle transitions retain that binding. Version 1 lifecycle records remain readable; they grant no common-lease recovery authority. The common lock's existing version 1 bytes remain compatible with other consumers.

Only `recoverIncompletePublication(target)` in `runtime/lib/publisher.mjs` may transfer a retained common lease. It requires an intact producer binding, the same host and owner PID, and `kill(pid, 0)` returning `ESRCH`. A live PID (including reuse), `EPERM`, unknown liveness, absent/tampered linkage or foreign host blocks. Before transfer, existing lifecycle validators inspect journal, ownership and interrupted atomic roles without settling them. The neutral common kernel receives their typed physical witnesses and rechecks token, inode, bytes, links and stable ancestry; it never interprets a lifecycle journal or accepts a takeover callback. The host witness comes from the acquired lease's lifecycle producer, never from coincident PIDs in old sibling files.

An exclusive hardlink at `<common-lock>.recovery-<old-token>` claims retirement of that exact lease. Competing recovery cannot claim it twice. Normal acquisition checks this role before and after exclusive creation, preventing effects in the handoff gap. The claimant rechecks the bound controls and dead owner before unlinking the old canonical link, exclusively creates a new common lease, and removes only its verified retirement link. It never renames over a newly acquired foreign lease. Interrupted or changed handoff roles remain diagnostic and block new work. An interruption before a durable binding exists, or after common installation but before the lifecycle lock is rebound, also remains blocked; no ownership is reconstructed from PID, age or filenames.

Recovery then acquires lifecycle ownership in the original common→lifecycle order and persists the new real lease binding before recovering the same transaction. It checks active/uncertain execution in the target and retained stage/backup, including when the target is absent, then reuses the existing verified commit/rollback and history-preservation rules. Repeated recovery returns `false` after completion. A mutable lifecycle retry uses this recovery entry before evaluating new work; recovered INIT still diagnoses `INIT destination already exists`. Normal common acquisition continues rejecting retained leases. No timeout, generic takeover, runner-terminal inference or manual lock deletion is authorized.

A successful lifecycle release atomically persists validated `released` state. Reclaim and transaction cleanup retain their inode/payload/digest checks. The protocol coordinates accidental overlap between participating sequential writers; it does not authenticate hosts with indistinguishable identities or defend against a process rewriting all controls.

Consumer repositories should ignore publisher lock files with `.*.lifecycle.lock`; the lock remains persistent on disk so interrupted operations can be validated and recovered safely.

## JSON and transaction artifact lifecycle

| Category | Files | Lifecycle |
|---|---|---|
| External ephemeral input | RESUME transition manifest | Captured by inode and digest, consumed after safe candidate validation and before journaling, and also removed on pre-publication failure. A replacement or unknown file is preserved. |
| Persistent evidence | Readiness attestation | Lives outside the SPEC, bound to the validated snapshot, retained across a safe promotion rollback for direct retry, and consumed by successful `CLOSE`. |
| Required recovery | Transaction journal and ownership proof | Preserved while recovery is possible or required; removed only after a verified commit or rollback. Foreign, corrupt, or inconsistent evidence is never deleted. |
| Persistent lock state | Lifecycle lock | Follows the concurrency contract below. Released state remains inspectable; active or foreign state is never age-deleted. |
| Internal temporary | Build, stage, backup, quarantine, and atomic-write temporary paths | Created outside the SPEC under transaction ownership and removed only after verified terminal state. Unknown replacements are preserved. |

No temporary JSON, manifest, helper script, or scratch report belongs inside the SPEC. Runtime diagnostics identify intentionally retained recovery or readiness evidence by exact path.

Target, candidate, manifest, attestation, lock, journal, stage, and backup paths reject traversal, symlink components, aliases, namespace collisions, and unsafe containment. Snapshot digests include bytes, entry types, link counts, and relative hardlink peers. Source and candidate digests are rechecked across validation and rename boundaries; a concurrent conflict restores the official source path before reporting failure. OS packaging metadata is outside authority and is rejected from deterministic CLOSE output.

## Maintenance

`maintenance/runtime-context-budget.json` records instruction dependencies and explicitly excludes embedded runtime source from normal context. The repository's Node suites exercise structural and transition contracts, readiness binding, deterministic rendering, publication, real concurrency, interruption recovery, isolated installation, path spaces, UTF-8, and static self-containment.
