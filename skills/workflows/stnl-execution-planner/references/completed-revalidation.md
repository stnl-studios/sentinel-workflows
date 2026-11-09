# File Purpose Header

```yaml
purpose: Describe explicit reviewed recovery of authenticated stale completed proofs.
status: not_applicable
read_when: A completed contribution has authenticated observed-product drift.
do_not_read_when: Execution has current proofs or an active operation owner.
contains: Exact stale identity selection, review, publication recovery and fresh validation.
owner: stnl-execution-planner
update_policy: Update only with the completed-revalidation producer contract.
```

# Reviewed revalidation of stale completed contributions

Use this bounded flow only when the current reader reports `EVIDENCE_STALE` because an authenticated completed proof no longer matches its observed product. This is not a corruption repair, a scope change, or evidence reuse.

1. Preserve the activation, continuity, all evidence and retained sources. An active owner, pending normalization, missing or malformed source, changed requirements, or unsupported authority blocks this flow. The live delivery queue must be empty.
2. Read the current completed UUIDs from continuity. The read-only runtime export `captureCompletedRevalidationSource(specPath, ids)` authenticates the full historical source and observes current work without granting validity or a handoff. Supply the completed UUIDs as candidate identities. If some are current, its fail-closed diagnostic names the exact authenticated stale set. Retry with exactly that set. Foreign identities, omitted stale contributions, and additional current contributions are rejected.
3. Allocate a new isolated preparation using `prepare-task-candidate.mjs --spec-path SPEC_PATH --operation REPLAN --completed-delivery-ids 'JSON_UUIDS_STAYING_COMPLETED' --revalidate-completed-ids 'JSON_EXACT_STALE_UUIDS'`. Do not combine this with `--terminal-validation`. The registry binds the selected UUIDs and the exact new observations; later product changes invalidate the preparation, even when the product remains stale.
4. Author Plan/Tasks from the current normative leaves and local templates. Preserve every requirement, dependency, integral owner, authorized area, input, recipe and other local normative field. The producer increments preparation revision and each reopened local revision. It reconstructs historical carriers from authenticated sources, preserves all records, objects, counters and baselines, and clears current validation claims. Do not copy old operational claims into a new PASS or add a pretend private change.
5. Follow the normal editable-draft capture, explicit user approval and independent REVIEW_PLAN workflow. Use the exact returned authorities, artifact hashes and evidence decisions. Every reopened contribution must have `revalidate`; unchanged completed contributions retain their ordinary reviewed disposition. A stale capture cannot inherit approval. A changed product requires a fresh preparation, not marker or registry edits.
6. Publish only the reviewed candidate. Readback must show the same identities, increased revisions, historical formal status, `revalidation-required`, and the legal VALIDATE_SLICE handoff. Preparation approval does not execute checks and cannot grant COMPLETE. Run fresh local validation through the normal admitted producer, then obtain a fresh terminal judgment. If the integral owner stayed completed, finish the current revalidation queue and use the existing reviewed Q18 retirement and Q20 terminal reentry path when the runtime requires it.
7. On an interrupted publisher, retain its exact returned allocation and use its official recovery command. Unconfirmed recovery restores and verifies the exact historical predecessor; confirmed recovery uses strict current readback. Do not remove a candidate, owner, registry entry, evidence file, or backup by hand.

This flow does not prove independence of arbitrary scripts, indirect dependencies, environment or database state. Fresh formal review remains mandatory. A fingerprint change is an observation, never a new write permission.
