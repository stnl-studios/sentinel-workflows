# Recover a retained first-formal anchor

The former producer could retain Initial implementation checks but omit their first formal `attempt-01` when a later local validation published `attempt-02`. A captured APPLY_FINDINGS could then fail publication with `retained implementation lacks its first formal anchor`. New compositions preserve that anchor proactively.

For that bounded legacy case only, the existing publisher accepts:

```sh
node <skill>/runtime/execution-current-operation.mjs publish \
  --handle <existing-captured-apply-handle.json> \
  --historical-evidence-file <preserved-first-formal-bundle.json>
```

This is not new approval, a verdict override, cleanup, or permission to rerun checks. Preserve the existing handle, captured response, observations, current source and all historical bytes. Do not edit evidence JSON to manufacture a predecessor.

The operation must be captured APPLY_FINDINGS in the current-checks profile, before publication. The current bundle must have a retained implementation, `attempt-02`, no prior findings cycle and no first-formal anchor. The historical file must be an owned regular file whose exact SHA matches the predecessor CAS in the sealed second-formal request. Its authority, counters, implementation prefix and first PASS are validated. Wrong bytes, foreign ownership, symlinks and already-present anchors are refused before candidate creation.

Composition derives the findings cycle against the original source and captured receipt first. It adds only authenticated historical validation support and referenced objects to the new candidate. No source, request, capture or conclusion is rewritten. The resulting bundle retains the existing format and is independently readable without the historical file. Its reader verifies the first-formal prefix and the second-formal predecessor CAS.

After confirmed publication use normal inspect/resume and the admitted local revalidation handoff. Do not pass this option to other operations or substitute a new dispatch for the existing capture. Publication interruption uses the existing publication recovery protocol; retain the historical input until publication is confirmed. A missing or nonmatching historical source leaves the legacy case blocked rather than relaxing verification.
