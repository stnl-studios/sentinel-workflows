# Independent product oracles

`CASES` in `../scenarios.mjs` is the public task contract. Every case starts from the **same unchanged** `fixtures/todo` snapshot. No new method in one case is a prerequisite for another case.

```js
const result = await verifyCase({
  caseId: 'rename', // query | import
  workspace: '/absolute/path/inside/BASE/to/work',
  evidenceDir: '/absolute/path/inside/BASE/evidence/new-unique-directory'
});
```

`evidenceDir` must not already exist, must be disjoint from workspace, and must be below BASE/temp or BASE/evidence. It contains captured product, frozen baseline tests, bounded subprocess logs and report.json. The API returns `{status, checks, productHashes, ...provenance}`. A behavior failure returns FAIL; unsafe arguments or existing evidence reject before execution. No tests from the model's workspace are used. Source files are not edited.

Verification snapshots all regular src files and package.json, rejects symlinks and oversized product files, and checks product hashes before and after execution. Baseline test fingerprints are pinned in baseline-hashes.json; changing the baseline requires an explicit reviewed fixture/qualification revision. Every subprocess has a 20-second wall limit and 2 MiB output limit; CLI probes have a 2.5-second limit. TMPDIR/TMP/TEMP/HOME point to the evidence scratch directory. Child process groups are killed on timeout/output exhaustion. Output must include the expected complete test count with no failures, skips or cancellations, so accidental early exit0 is not acceptance.

The snapshot/probe boundary is **not an OS security sandbox for hostile source code**. It prevents accidental workspace writes by normal tests and limits hangs, but arbitrary evaluated JavaScript still has the host account's filesystem capabilities. Do not call this a security containment guarantee. Product acceptance is also separate from formal Sentinel lifecycle evidence and CLOSE.

Run calibration:

    node --test bench/test/scenarios.test.mjs

Tests create small synthetic implementations solely inside BASE/temp and remove their own temporary trees. They establish that the original fixture fails all three new contracts while its existing regression passes; calibrated implementations pass; deliberately defective implementations fail. They do not represent model measurements or prove Sentinel lifecycle completion.

Import atomicity means the whole payload is validated before one store.write. It does not add concurrency transactions, exactly-once replay or crash-recovery guarantees beyond the fixture's existing replace-on-write store behavior.
