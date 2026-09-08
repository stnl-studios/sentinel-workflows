# File Purpose Header

```yaml
purpose: Define requirements-source normalization and fingerprinting, execution states, recovery revisions, paths, and slice normalization.
status: not_applicable
read_when: PLAN or REPLAN derives an execution workspace/state, or another execution skill needs the same deterministic path rules.
do_not_read_when: All selected artifact paths are already explicit and verified.
contains: SPEC_PATH forms, execution layout, authority fingerprints, revision and supersession rules, relative paths, and SLICE normalization.
owner: stnl-execution-planner
update_policy: Change only when execution workspace or identifier rules change.
```

# Execution Workspace

Normalize `SPEC_PATH` without guessing:

1. A directory is valid only when it contains `feature_spec.md`; use that file and its `execution/` child.
2. A direct `feature_spec.md` path uses the same `execution/` sibling directory.
3. Another existing requirements file remains unchanged and uses a sibling `<stem>-execution/` directory.

The execution root contains only:

```text
plan.md
plans/slice-NN.md
tasks.md
tasks/slice-NN.md
```

Before classifying a lifecycle workspace as `EMPTY`, inspection checks the exact official `98545e4` root-level execution signature (`plan.md`, `plans/plan-NN.md`, `tasks.md`, and `tasks/tasks-NN.md` with their historical owners, primary H1s, tables, and paired filenames). A match is explicit blocked legacy, never empty and never migrated. Current malformed or hybrid siblings are not inferred as historical.

No other persisted file or directory is canonical inside the execution root. Never create analysis notes, review checklists, manifests, helper scripts, scratch files, or ad hoc reports there. When temporary support is indispensable, use an operating-system temporary directory outside the SPEC. Unknown execution-root paths and unsafe reserved lifecycle entries block with their exact path and required relocation or explicit removal; arbitrary user-owned SPEC-root siblings are allowed and preserved. Workflow skills never delete them automatically.

Every persisted path is relative to its containing artifact. For a colocated SPEC, `plan.md` refers to `../feature_spec.md`; detailed plans and tasks refer to `../../feature_spec.md`; a detailed task refers to `../plans/slice-NN.md`.

Validation-owned implementation paths are normalized relative to the detailed task. Their trusted boundary is the nearest ancestor of the requirements source containing a real, non-symlink `.git` directory or file. If no such marker exists, the boundary is the lifecycle SPEC root or the standalone requirements directory. Paths may leave a nested lifecycle SPEC only when they remain inside that deterministic project root. Escapes and symlink traversal always block.

The requirements authority is the normalized requirements source plus every lifecycle-owned requirements artifact that supplies its current documentary authority, using the canonical versioned snapshot algorithm `stnl-requirements-authority-v1`. Plans persist exactly `- Requirements authority: sha256:<64hex>` and `- Plan revision: <positive integer>`. The global plan declares the current pair. Each detailed plan and task retains the pair under which that slice was created. Historical `PASS`, `ACCEPTED` or `SUPERSEDED` slices are never rewritten merely because current authority changed.

`SLICE` accepts one unsigned decimal number without a prefix and normalizes it to zero-padded `slice-NN`. Reject missing, signed, negative, decimal, prefixed, or non-numeric values. Never infer a slice.

Always ignore `__MACOSX`, `.DS_Store`, and `._*`; they are never workflow artifacts. The deterministic states are:

- `EMPTY`: the root is absent or has no non-ignored entries. This is structural observation: standalone `EMPTY` and lifecycle `ready + EMPTY` authorize `PLAN`; lifecycle `draft|blocked + EMPTY` remains inspectable but exposes no legal or normal `PLAN` handoff;
- `PLANNED_DRAFT` / `PLANNED_READY`: the exact plan set named by the global Serial Slice Order exists without tasks; this includes a planning-only replacement, which remains revision `1` and carries no historical recovery fields;
- `PENDING_REPLAN_DRAFT` / `PENDING_REPLAN_READY`: tasks already exist and an append-only extension or materialized-pristine replacement is staged without changing task history;
- `MATERIALIZED_PRISTINE`: tasks exist with unchecked rows and exact sentinels, including `Delegation Blocker: - none`;
- `EXECUTION_STARTED`: operational content exists but no more-specific phase applies;
- `IMPLEMENTED_AWAITING_VALIDATION`: terminal implementation check evidence with a complete mandatory checklist permits only `VALIDATE_SLICE` or authority-driven `REPLAN`; a pre-existing terminal record with an incomplete checklist retains this observed state but collapses legality to mandatory same-slice `EXECUTE_SLICE` recovery owned by `stnl-slice-executor`;
- `VALIDATION_NEEDS_FIX`: active formal findings permit `APPLY_FINDINGS` or independent `VALIDATE_SLICE` reobservation of manual fixes;
- `FINDINGS_CORRECTED`: terminal findings-check evidence permits only `VALIDATE_SLICE` or authority-driven `REPLAN`;
- `VALIDATION_BLOCKED`: the latest formal attempt is `BLOCKED`;
- `IMPLEMENTATION_RETRY_EXHAUSTED` / `FINDINGS_RETRY_EXHAUSTED`: round `3/3 TESTS_FAIL` permits only `VALIDATE_SLICE`, except that inconsistent implementation exhaustion with an incomplete checklist first requires the same narrow executor recovery;
- `AUXILIARY_BLOCKED`: a valid auxiliary `BLOCKED` exposes and resumes only its persisted concrete operation, slice, record, and round;
- `RUNNER_INITIALIZATION_BLOCKED` / `RUNNER_RESULT_BLOCKED`: an active `Delegation Blocker` exposes and resumes only its persisted concrete operation and containing slice, plus its prior-record cursor when one exists;
- `REQUIREMENTS_CHANGED` and `REPLAN_REQUIRED`: execution waits for exact authority recovery; `DIVERGENCE_BLOCKED` also exposes an owning-operation revalidation target before deciding whether authority recovery remains necessary;
- `COMPLETE`: every row is terminal `PASS`/`ACCEPTED` or forward-linked `SUPERSEDED`, final ownership ends in later current-authority `PASS`/`ACCEPTED`, and effective blockers and drift are absent.

`SUPERSEDED` is also terminal, but never successful validation: an append-only approved replan commit may change an open prior row to `[x]`, validation `SUPERSEDED`, result `SUPERSEDED`, and the detailed Final Result to `SUPERSEDED` with its replacement slice. Its historical implementation and validation evidence remain immutable. Active records retained in that terminal history do not poison the replacement; every claimed path still requires later `PASS`/`ACCEPTED` ownership. `COMPLETE` for execution close therefore means every row is terminal (`PASS`, `ACCEPTED` or `SUPERSEDED`), every non-superseded delivery has current valid `PASS`/`ACCEPTED` ownership, no effective active blocking finding or divergence remains, and at least one current-revision `PASS`/`ACCEPTED` reconciliation/corrective slice covers affected authority and final paths after a requirements change.

No non-terminal recovery state is terminal. The shared runtime derives structured recovery targets from persisted state, including operation, nullable slice, recovery owner, applicable record/round/retry state, and whether same-operation resume is mandatory. Every persisted authority record retains a distinct target identity. Executable action presentation may deduplicate only genuinely equivalent owner/mode/slice actions; multiple lifecycle `MODE=RESUME` records therefore remain present while one aggregate handoff carries no arbitrary record identity. Human diagnostics are rendered from those targets. Unscoped authority recovery keeps `slice: null`; it never fabricates scope from the current request. Candidate validation rejects any terminal implementation result whose mandatory checklist is incomplete, so the inverse ordering cannot be newly published. For an already-persisted occurrence, only exact `EXECUTE_SLICE` on the affected slice is legal; wrong-slice, validation, replan, and unrelated requests retain that concrete recovery target. Completing the checklist removes the override and restores the ordinary state-derived handoff. A normally consistent `IMPLEMENTED_AWAITING_VALIDATION` never reopens execution.

In `tasks.md`, machine authority is the File Purpose Header, owner/status, primary H1, the unique canonical table header/separator, contiguous row grammar/order, checkbox, slice/detail mapping, Validation/Result values, and detailed-task cross-checks. Explanatory prose and Markdown-equivalent whitespace outside the table are editorial: they neither derive state nor create or mask a row. Fenced code and HTML comments are also editorial and cannot supply or mask the primary H1, table header, separator, or rows. Row-like pipe-delimited residue outside the authoritative table remains structural corruption.

`REPLAN` has three deterministic mutation classes. With planning but no tasks, atomically replace the exact planning authority, remove obsolete detailed plans, remain at revision `1`, omit historical recovery fields, and return through review plus initial materialization. With wholly pristine materialized tasks, use the existing increasing `pristine-replacement` revision and atomic plan/task replacement. After any operational evidence/history, use only an increasing `append-only-extension` and preserve history. A pending materialized `REPLAN` persists a non-placeholder reason, increments the highest materialized plan revision by exactly one, and declares `Supersedes open slices` as `none` or unique canonical `slice-NN -> slice-NN` mappings. A pristine replacement declares `none`. An append-only extension maps only open historical sources to newly appended later targets, and an authority-changing extension maps every stale open slice. Before materialization, every effective nonterminal slice after the first open serial frontier remains exactly pristine.

`COMPLETE` is a terminal refinement of `EXECUTION_STARTED`. A partial or malformed artifact set is not coerced to a valid state and blocks mutation. Only an operation authorized to create artifacts may create a missing execution root. Block collisions with the source, a non-directory, unrelated content, or an unrecognized layout.

A failed quality command or external path never proves a REPLAN need. Gate-driven REPLAN requires current Gate assessments proving relevance, causal obligation, a necessary authority change and no valid in-scope correction. Revalidate persisted blockers first. The shared runtime permits terminal ACCEPTED alongside PASS, carrying the same manifest/authority/mandatory requirements guarantees and distinct explicit acceptance of optional quality debt; it is never reported as PASS.
