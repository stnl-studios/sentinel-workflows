# File Purpose Header

```yaml
purpose: Separate append-only validation attempts from the one replaceable effective PASS base used for final drift detection.
status: not_applicable
read_when: VALIDATE_SLICE persists a runner result or CLOSE verifies post-validation drift.
do_not_read_when: Executing or correcting a slice before independent validation.
contains: Attempt sequence, effective PASS authority, complete manifests, overlap, hashes, removed-file marker, commands, and replacement rules.
owner: stnl-slice-quality-manager
update_policy: Change only when validation persistence or drift verification changes.
```

# Validation Attempts and Effective Validation Base

## Validation Attempts

Every valid runner invocation appends exactly one sequential `attempt-NN` and never changes an earlier attempt. `attempt-01` is `initial`; every later attempt is `revalidation`. Persist status (`PASS`, `NEEDS_FIX`, or `BLOCKED`), HEAD or `not_available`, verified scope, exact commands and numeric exit codes, compact evidence, findings, blockers, unexpected workspace effects, and persistence summary. Do not persist full logs or hashes as final authority inside an attempt.

## Effective Validation Base

At most one Effective Validation Base may exist. `NEEDS_FIX` and `BLOCKED` never create or update it. A current `PASS` creates it, or replaces the entire previous base when the current attempt is a revalidation. The origin must name the current `PASS` attempt and record its type, HEAD or `not_available`, `Result: PASS`, authoritative commands with numeric exit codes, compact evidence, and one final manifest.

The manifest is the complete final state needed to sustain the slice's `PASS`, not merely the latest corrections. It includes original implementation paths, findings corrections, additional necessary effects, removed paths, relevant tests, and every earlier-slice overlap claimed by the current slice. Paths are relative, unique, normalized, and lexicographically ordered. Existing files use lowercase SHA-256; absent validated paths use exactly `REMOVED`. A fileless slice requires an explicit objective reason and observable evidence.

Before persistence, reject missing, malformed, duplicate, unsorted, or contradictory paths; malformed hashes; a path reported as existing that is absent; a removal marker for a present path; missing original/correction/overlap paths; unjustified extra paths; missing directly justified regressions for prior-slice overlap; nonzero authoritative command exits; or an origin attempt that is not the current `PASS`. Never invent or recompute missing runner results. Validate the complete candidate base before replacing the previous one.
