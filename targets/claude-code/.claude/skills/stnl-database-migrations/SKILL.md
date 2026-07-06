---
name: stnl-database-migrations
description: Sensitive-area rules for bounded database access, schema changes, migrations, transactions, indexes, and data compatibility.
---

# Database and Migrations

Use only when the approved slice explicitly includes persistence or migration work. Coder and validator use this skill only under the restricted Sentinel matrix.

## Inspect first

- Identify the database, ORM/query layer, migration tool, transaction ownership, deployment model, and existing conventions from scoped paths.
- Determine data volume, null/default semantics, compatibility window, lock risk, and rollback/forward-fix expectations stated by the plan.

## Apply

- Keep reads/writes bounded and parameterized. Avoid N+1 access, unbounded scans, and user-controlled query structure.
- Make transaction boundaries and failure behavior explicit; do not hide cross-resource consistency assumptions.
- Use additive/backward-compatible migration steps when rolling deployment can mix versions.
- Separate schema change, data backfill, constraint enforcement, and cleanup when one step would create lock or compatibility risk.
- Make migrations deterministic and safe to retry when the project's tool/model expects it.
- Add indexes only for demonstrated access patterns and consider write/storage cost.
- Preserve existing data; never use destructive defaults or irreversible cleanup without explicit approval and recovery strategy.

## Evidence

Validate generated SQL or migration operations when practical. Test apply behavior, relevant application queries, constraints, and approved rollback/forward recovery. Report database/version and whether evidence used an empty or representative populated state.

## Stop

Block for destructive data change, unknown production volume, long-lock risk, missing compatibility/rollback decision, cross-service schema contract, new datastore, or undeclared migration path.
