# stnl-spec-lifecycle-manager

This self-contained package maintains independent documentary feature SPECs through `INIT`, `RESUME`, `READINESS`, and `CLOSE`. It does not plan or execute implementation work.

## Installation and runtime

Copy only this directory. At use time, derive `<SKILL_ROOT>` from the directory containing the loaded `SKILL.md`; neither the current process directory nor a platform-specific skill location is authoritative. The operational entrypoints are:

- `runtime/validate-spec-lifecycle.mjs`
- `runtime/create-readiness-attestation.mjs`
- `runtime/build-closed-spec.mjs`
- `runtime/publish-spec-lifecycle.mjs`

Invoke them directly with `node "<SKILL_ROOT>/runtime/<entrypoint>.mjs" ...`. They use only native Node modules and require no package manager, build, repository-relative resource, environment convention, or external executable. Runtime source is executed, not loaded into the model's normal context; `SKILL.md` and the selected references retain progressive disclosure.

## Documentary contracts

An active workspace owns `feature_spec.md` plus materialized categories in `shared/`. Canonical headings are the sole ID authority, metadata is an ordered Markdown list, records retire in place, and structural relationships remain bidirectionally validated. `READINESS` is read-only. Only semantic `GLOBAL/READY` creates an external attestation bound to the canonical lifecycle-authority snapshot. `CLOSE` requires that current attestation, renders exact canonical bytes, validates the transition, and publishes without model-authored consolidation.

## Publication and recovery

The publisher stages a complete disjoint candidate, validates its captured digest, journals every transactional phase, renames the source to a transaction-owned backup, verifies that backup, promotes the stage, revalidates the official path, and removes transaction residue only after commit. Journal schema version 2 preserves exactly ten fields: version, mode, target/stage/backup names, phase, source/candidate/observed digests, and transaction identity. A strict sibling ownership sidecar, `.<workspace-name>.lifecycle-ownership-<transaction-id>.json`, binds that transaction to the persisted device/inode identities and digests of its stage, source, backup, and promoted target. Recovery runs under the lock before new work and either completes a verified commit or restores and validates the exact captured source. Corrupt, foreign, or inconsistent metadata is preserved and rejected rather than treated as deletion authority.

The sibling `.<workspace-name>.lifecycle.lock` is strict JSON in a single-link regular file. Acquisition writes and synchronizes a private build, atomically exposes a complete claim through the native hardlink primitive, settles the claim to one canonical link, and fails safely when the filesystem cannot provide that primitive. It records lock version/state, owner and operation identities, transaction identity, process ID, host, and start time; every transition revalidates the complete payload and inode. A successful release atomically persists a validated `released` state. An `active` lock is never removed merely because it is old: orphan recovery requires matching host, a proven-dead process, valid schema/link identity, and consistency with any journal transaction. Reclaim and transaction cleanup use quarantine renames followed by immediate inode, payload, and digest revalidation, so concurrent publishers cannot both acquire or delete a foreign replacement.

Consumer repositories should ignore publisher lock files with `.*.lifecycle.lock`; the lock remains persistent on disk so interrupted operations can be validated and recovered safely.

Target, candidate, manifest, attestation, lock, journal, stage, and backup paths reject traversal, symlink components, aliases, namespace collisions, and unsafe containment. Snapshot digests include bytes, entry types, link counts, and relative hardlink peers. Source and candidate digests are rechecked across validation and rename boundaries; a concurrent conflict restores the official source path before reporting failure. OS packaging metadata is outside authority and is rejected from deterministic CLOSE output.

## Maintenance

`maintenance/runtime-context-budget.json` records instruction dependencies and explicitly excludes embedded runtime source from normal context. The repository's Node suites exercise structural and transition contracts, readiness binding, deterministic rendering, publication, real concurrency, interruption recovery, isolated installation, path spaces, UTF-8, and static self-containment.
