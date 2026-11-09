# Historical CLOSE archive maintenance

Maintenance reference only; not a runtime instruction dependency.

## Superseded native sources

A committed native owner can outlive its literal replica in current bounded evidence. The publisher may preserve its complete operational inventory in a `stnl-close-history-v1` archive outside the material namespace on the same verified device. It admits only settled, same-SPEC native owners with exact allocation/origin associations and regular single-link files. Foreign, running, uncertain, aliased or incomplete material still blocks CLOSE.

The archive stores exact bytes, modes, paths and source identities, including registry bytes. Limits are 1,024 inventory roles, 8 MiB per source file and 64 MiB serialized archive; exceeding a limit preserves originals and blocks admission. Exclusive creation, file and parent fsync, and readback precede the journal. The journal and terminal witness bind its exact path, identity, digest and size. Each destructive role barrier rechecks archive integrity; mutation stops cleanup and preserves remaining sources.

The archive is inert retained history, never execution evidence or a PASS/COMPLETE source. Current COMPLETE remains independently required when execution exists. Successful results include `historicalArchive`; cleanup complete means operational controls were settled, not that retained history was deleted. Pre-journal copy/fsync failures can leave unbound partial archives: preserve them, never adopt or delete them automatically. A new attempt may create its own archive; committed recovery reuses the exact bound one without reconstruction.

Parent-directory fsync is strict: unsupported durability blocks admission. Final destructive barriers verify both archive integrity and source bytes after archive readback. Tests use a disposable legacy-producer copy whose only retention-policy change returns selected support; native owners are generated, never fabricated.
