# File Purpose Header

```yaml
purpose: Define preconditions, allowed changes, safe publication, and completion behavior for the four SPEC lifecycle modes.
status: not_applicable
read_when: Selecting or applying INIT, RESUME, READINESS, or CLOSE.
do_not_read_when: Only a canonical item shape or isolated relationship rule is needed.
contains: Explicit mode boundaries, transition restrictions, candidate publication, and concise outcomes.
owner: stnl-spec-lifecycle-manager
update_policy: Change only when lifecycle semantics change.
```

# Lifecycle MODEs

Require exactly one explicit `MODE=INIT|RESUME|READINESS|CLOSE`. Never infer a mode, treat another name as an alias, or combine modes. `INIT` and `RESUME` have non-overlapping preconditions.

Optional free-text additional context is transient. It may narrow the selected MODE for a current restriction, risk, preference, or recent fact, but never replaces selective reading or persisted authority, persists automatically, or permits work outside the MODE. If it materially conflicts with the SPEC, block, identify the artifact or ID, and direct the caller to `RESUME` or the applicable mode; do not silently rewrite the SPEC.

## Safe publication for mutable modes

`INIT`, `RESUME`, and `CLOSE` use one rollback-safe protocol:

1. Resolve and read canonical authority; snapshot the live lifecycle state and every external path that must remain unchanged.
2. Build the complete candidate in an isolated temporary directory. Do not edit the live workspace incrementally.
3. Validate candidate structure.
4. Validate the mode transition against the pre-operation snapshot, including allowed paths and preservation rules.
5. Correct only the candidate, then repeat both validations until they pass.
6. Publish the complete validated candidate as one rollback-capable replacement, with protected external paths present and unchanged. Recheck the `INIT` destination is still absent immediately before publication.
7. Validate the published state and compare protected external paths with the snapshot.
8. On any failure, keep or restore the prior live state and report the failed validation; never leave a partial workspace.

The candidate is not authority and cannot be used to justify its own changes. Validators prove explicit structure and relations; the model remains responsible for semantic sufficiency, clarity, coherence, and non-invention.

After staging the full candidate, publish only with `python3 scripts/publish_spec_lifecycle.py <INIT|RESUME|CLOSE> <TARGET> <CANDIDATE>`. The publisher accepts no other mode, validates structure and transition before replacement, revalidates the published state, and rolls back on failure. `READINESS` never invokes it.

## INIT

Require explicit `MODE=INIT`, `SPEC_PATH`, and `REQUIREMENTS_SOURCE`. `SPEC_PATH` must designate a nonexistent directory both when the operation begins and immediately before publication. Block any existing file or directory; never treat an existing directory without `feature_spec.md` as an initialization target.

INIT has two conceptual stages. First, bootstrap the smallest structurally valid workspace from supplied evidence, materializing no empty category and only questions that are genuinely relevant. Second, evaluate readiness only when the evidence is sufficient to make a readiness claim. If the input plainly supports only a draft or blocked SPEC, stop after valid bootstrap; do not load the full readiness contract, manufacture requirements, or expand boilerplate to simulate completeness.

## RESUME

Require explicit `MODE=RESUME`, `SPEC_PATH`, and `NEW_INFORMATION`. Operate only on an existing, valid, active workspace whose `feature_spec.md` predates the operation. Apply supported answers, decisions, corrections, or scope deltas only to affected authority.

Preserve the feature H1 identity and every existing identifier, record type, record identity, valid reference, and unaffected durable byte content; never recreate the workspace from templates. New IDs are the highest previously allocated suffix plus one within their category; never renumber, reuse, or fill a gap. A local correction reads its record and necessary dependencies; a category change reads that category and dependencies; a transversal change reads all materially affected authority. Change feature status only after the applicable gates pass.

## READINESS

Require explicit `MODE=READINESS`, `SPEC_PATH`, and `READINESS_SCOPE=LOCAL|GLOBAL`; `LOCAL` also requires a bounded `READINESS_FOCUS`. This mode is strictly read-only: do not create a candidate, write or repair files, change status, create a plan or tasks, or implement code. Use the evidence sets and verdicts in `readiness-gates.md`.

## CLOSE

Require explicit `MODE=CLOSE` and `SPEC_PATH`; never infer closure. The source must be a valid active `ready` workspace and pass every global readiness and closure gate. Consolidate existing authority without adding, rewriting, or silently discarding canonical content. Follow `close-policy.md`; implementation state and evidence are never prerequisites.

## Concise outcome contract

Return only mode verdict/status, changed lifecycle files (none for READINESS), documentary decisions, actionable blockers/findings with IDs or paths, validations, and the next allowed step. Do not repeat the SPEC, inventories, histories, commands, internal reasoning, or already persisted prose.
