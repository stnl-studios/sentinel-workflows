# Public runtime-context baseline

`runtime-context-baseline.snapshot.json` is a numeric metadata snapshot of the seven
framework Markdown files at the `baseline_revision` already declared in
`runtime-context-budget.json`. It includes the original paths, raw byte lengths,
per-file whitespace word counts, SHA-256 hashes, Git blob SHA-1 hashes, mode file
lists and sums, and the original maximum ceilings and minimum reductions.
It contains no historical file contents, Git objects, refs, or private history.

Run `npm run test:runtime-context-budget` (or
`node scripts/test-runtime-context-budget.mjs`) in a fresh checkout or source
archive. Neither command requires Git, the historical commit, a network connection,
or installed packages. The snapshot's canonical JSON digest is pinned in
`scripts/lib/runtime-context-budget.mjs`; the exact digest algorithm and measurement
algorithms are recorded in the snapshot. The test checks every mode against the
snapshot and checks the current runtime files against the unchanged budget.
Omitted metadata, altered measurements/hashes, and relaxed ceilings or reduction
requirements fail closed. Stricter ceilings and reductions remain possible.

For maintainers who already have the original revision locally, explicitly run
`node scripts/audit-runtime-context-baseline.mjs`. This optional archaeological
audit measures each original framework file and compares all four metadata
fields. It fails if Git or the original objects are unavailable, with no fetch,
import, regeneration, or fallback. It is not part of the normal test runner.
Hashes allow holders of the original files to verify their identity; they do not
let a public clone reconstruct those historical files independently.

Changing the baseline requires an explicit reviewed migration of the snapshot,
its digest pin, and any affected manifest contract. Do not regenerate it from
current files to make a failing budget pass. Do not distribute historical objects
or raw private source files to enable this test.
