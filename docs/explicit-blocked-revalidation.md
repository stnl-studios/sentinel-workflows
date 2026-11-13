# Explicit revalidation after a concluded formal BLOCKED

A recorded formal BLOCKED remains blocked by default. Fixing an external prerequisite or regenerating a declared Existing Input does not itself grant a new judgment. With explicit authorization to revalidate that blocked slice, use the existing operation lifecycle:

```sh
node <skill>/runtime/execution-current-operation.mjs begin \
  --spec-path <spec> --slice slice-01 --operation VALIDATE_SLICE \
  --expected-activation-id <current-quiet-activation> --retry-blocked
```

This admits a new independent validation, not a replay or reinterpretation of the old verdict. Use the returned handle and the ordinary reserve-dispatch, bind-native, verify, capture and publish steps. Preserve the previous target: reserve with `--terminal` only when the blocked judgment was terminal, and without it when the blocked judgment was local. Bind a new independent runner. New recipe execution belongs to this explicitly authorized new operation; the previous capture is never rerun or edited.

Eligibility is deliberately narrow:

- Quiet current-checks execution, latest concluded formal BLOCKED, no active owner, normalization, retained refusal, auxiliary BLOCKED or other uncertain/blocked delivery.
- Same approved authority and slice. This is not REPLAN, scope expansion, implementation or APPLY_FINDINGS authorization.
- No output or scope changes. Only content refreshes of exclusive declared Existing Input files outside every Authorized Area, with the same file kind and mode, are allowed; unchanged work is also eligible when an external prerequisite was resolved. New/deleted files and structural changes are not admitted by this path.
- Documentary bootstrap requests cannot use the flag to obtain another invocation.

The old BLOCKED record and its authenticated objects remain historical support in the new bundle. A new PASS is established only by the new independent conclusion; input refresh or flag use alone cannot grant acceptance. Default begin, mismatched local/terminal selection, reuse of a prior validator, output/authority changes and uncertain producers remain refused.

If an input must be regenerated, first settle any existing captured operation through its existing publication/recovery path. Never change that input while its captured observation is awaiting publication. Then perform the authorized input update, inspect the quiet state, and request the explicit revalidation. No CLOSE, RECONCILE or merge is implied.
