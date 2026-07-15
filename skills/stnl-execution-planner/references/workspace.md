# File Purpose Header

```yaml
purpose: Define requirements-source normalization, execution-root derivation, relative paths, and slice normalization.
status: not_applicable
read_when: PLAN derives an execution workspace or another execution skill needs the same deterministic path rules.
do_not_read_when: All selected artifact paths are already explicit and verified.
contains: SPEC_PATH forms, execution layout, relative-path rules, and SLICE normalization.
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

Every persisted path is relative to its containing artifact. For a colocated SPEC, `plan.md` refers to `../feature_spec.md`; detailed plans and tasks refer to `../../feature_spec.md`; a detailed task refers to `../plans/slice-NN.md`.

`SLICE` accepts one unsigned decimal number without a prefix and normalizes it to zero-padded `slice-NN`. Reject missing, signed, negative, decimal, prefixed, or non-numeric values. Never infer a slice.

Ignore `__MACOSX`, `.DS_Store`, and `._*` only when deriving whether an execution root is empty; they are never workflow artifacts. The deterministic states are:

- `empty`: the root is absent or has no non-ignored entries;
- `planned`: approved or draft `plan.md` and its detailed plans exist, while `tasks.md`, non-empty `tasks/`, and operational evidence do not;
- `materialized-pristine`: the complete task set exists; every global and local checkbox is `[ ]`; global validation/result cells are `pending`; and every detailed task uses the template sentinels for changed areas, scope expansion, prior overlap, divergences, developer checks, attempts, findings, corrections, effective base, diff summary, and final result;
- `execution-started`: any local task is `[x]`, any global row is `[x]`, or any detailed sentinel above has been replaced by operational content;
- `complete`: every global row is `[x]`, every detailed result is `PASS`, every completed slice has one valid Effective Validation Base originating from a `PASS` attempt, and no blocking finding or divergence remains.

`complete` is a valid terminal refinement of `execution-started`. A partial or malformed artifact set is not coerced to a valid state and blocks mutation. Only an operation authorized to create artifacts may create a missing execution root. Block collisions with the source, a non-directory, unrelated content, or an unrecognized layout.
