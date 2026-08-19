---
name: stnl-database-persistence
description: Sensitive-area persistence guardrail for SQL, ORM, NoSQL, cache, migrations, transactions, indexes, bounded access, consistency, and production-safe evidence.
---

# Database and Persistence

Use only when the approved slice explicitly touches persistence, queries, schema, migrations, indexes, cache, transaction behavior, bulk data work, or data consistency. This is a sensitive-area skill: preserve the approved boundary and the project's datastore/ORM/migration conventions rather than redesigning data architecture.

## Inspect first

- Identify datastore and version where available, ORM/query layer, repository/DAO pattern, migration tool, transaction ownership, deployment model, cache role, and scoped access patterns.
- Determine expected cardinality/data volume, null/default semantics, ordering, compatibility window, lock risk, retry behavior, and rollback/forward-fix expectations relevant to the change.
- Inspect the query callers and the resulting materialization boundary, not only the query text. N+1 and unbounded access often appear across layers.
- Reuse established predicates, specifications, query objects, projections, migration patterns, and naming conventions.

## Data-access gate

- Keep reads and writes bounded. Potentially large collections require a limit, pagination/cursor, aggregate, stream/batch strategy, or explicit evidence that cardinality is safely bounded.
- Reject N+1 access from lazy loading, navigation traversal, repository/API calls inside loops, or per-row enrichment when a bounded set/batch query is practical.
- Push filtering, ordering, grouping, projection, and aggregation to the datastore when appropriate; avoid materializing large data before filtering.
- Select only needed data when the local stack supports projection without harmful complexity. Avoid accidental large object graphs or excessive eager loading.
- Parameterize values. Allowlist user-controlled fields, sorts, operators, filter fragments, collection names, or other structural query elements.
- Avoid raw SQL or lower-level datastore access that bypasses an established abstraction without a concrete reason.
- Bound parallel/bulk operations and consider throttling, batching, retry/backoff, memory use, and idempotency.

## Transaction and consistency gate

For multiple dependent writes or write-plus-side-effect flows, make explicit:

- what must be atomic;
- transaction/unit-of-work owner and scope;
- isolation/concurrency assumptions when relevant;
- retry/duplicate/idempotency behavior;
- partial failure and compensation behavior when atomicity cannot cover all resources;
- whether external calls/events occur inside or outside the database transaction.

Avoid long transactions and external calls inside a transaction unless project precedent and consistency requirements justify them.

## Schema and migration gate

- Prefer additive/backward-compatible changes when rolling deployment can mix application versions.
- Consider existing rows before adding non-null columns, defaults, constraints, uniqueness, type changes, or relation changes.
- Separate schema change, backfill, constraint enforcement, and cleanup when combining them increases lock, runtime, or compatibility risk.
- Make migration behavior deterministic and safely repeatable where the migration system expects it.
- Preserve data. Destructive cleanup, irreversible transforms, table rewrites, or high-lock operations require explicit approval and recovery strategy.
- Do not assume rollback is always safe; choose rollback or forward-fix according to project/deployment practice and the approved plan.

## Index and access-pattern gate

- Consider indexes for new/changed high-volume filters, joins, ordering, uniqueness, partition keys, or lookup patterns.
- Do not add speculative indexes. Balance read gain against write amplification, storage, maintenance, and overlapping indexes.
- For relational pagination, use deterministic ordering.
- For document/key-value/wide-column stores, model/query according to supported access and partition patterns; reject hidden global scans or hot-partition risks in critical paths.

## Cache gate

When cache is touched:

- define source of truth, namespace, tenant/user scope where relevant, key normalization/versioning, TTL or an explicit reason for no TTL;
- define invalidation/update behavior with source writes;
- avoid sensitive payload caching without project precedent and controls;
- avoid unbounded structures, large values, runtime key scans, or cache-as-database accidents;
- make cache miss/failure behavior safe and consider stampede protection for hot keys when applicable.

## Quality smells

Reject or correct material instances of:

- query/read/write inside a loop that creates N+1 or avoidable round trips;
- `ToList`/`AsEnumerable`/equivalent materialization before useful filters;
- unbounded `Promise.all`, full collection scans, or load-all-then-filter behavior;
- excessive include/eager-loading graphs;
- missing deterministic ordering for paged data;
- multiple dependent writes with unclear atomicity;
- schema changes that ignore old application versions or existing data;
- dynamic query structure derived directly from user input;
- an index added without a corresponding access pattern;
- datastore/domain/public contracts coupled unnecessarily;
- cache invalidation or tenant scoping left implicit.

Do not treat every loop, raw query, eager load, or missing index as a defect. Require a concrete cardinality, safety, consistency, or maintenance reason.

## Evidence

- Run the narrowest query/migration/application tests that prove the changed behavior.
- Inspect generated SQL/query plans or migration operations when practical and relevant to the risk.
- For migrations, validate apply behavior and affected application queries/constraints; exercise approved rollback or forward recovery when required.
- State datastore/version when known, exact commands/actions, and whether evidence used empty, fixture, or representative populated data.
- Do not claim production safety from a migration that was tested only against an empty schema when existing data is a material risk.

## Stop

Block and return to the Sentinel contract for destructive or irreversible data changes, unknown production volume where it materially affects safety, unresolved long-lock risk, missing compatibility/recovery decision, new datastore, cross-service schema contract, data ownership redesign, undeclared migration path, or security/compliance decision outside the approved slice.

Completion requires bounded access, intentional consistency, compatibility, and evidence. A query or migration that merely succeeds is not enough when it introduces material N+1, scan, lock, data-loss, retry, cache, transaction, or rollout risk.
