# File Purpose Header

```yaml
purpose: Define slice execution workspace selection, source preservation, relative paths, and artifact responsibilities.
status: not_applicable
read_when: Selecting an execution root or creating slice execution artifacts.
do_not_read_when: A selected detailed artifact already provides the needed local context.
contains: Standard layout, external-source handling, relative path rule, file boundaries, and source references.
owner: stnl-spec-execution-manager
update_policy: Change only when the execution workspace architecture changes.
```

# Execution Workspace

## `SPEC_PATH` normalization

Normalize `SPEC_PATH` before deriving any artifact. Do not broadly explore a repository to guess an invalid path.

1. A directory is valid only when it contains `feature_spec.md`. The requirements source is its `feature_spec.md` child and the execution root is its `execution/` child.
2. A direct path whose basename is `feature_spec.md` has its parent as the SPEC root. The requirements source is that exact file and the execution root is the sibling `execution/` directory in that parent.
3. Another existing requirements file remains the requirements source unchanged. Its execution root is the sibling `requirements-name-execution/`, where `requirements-name` is the file name without its final extension.

The first two forms must resolve to the same canonical source and execution root. Never move, rename, or alter the source while normalizing it. Persisted paths remain relative to the artifact that contains them.

Block with a concise diagnostic when the path does not exist; a directory has no deterministic `feature_spec.md` source; a directory offers more than one possible source without a deterministic selection rule; the derived execution root collides with the source, an existing non-directory, or an existing unrelated directory; or an operation requires artifacts that do not exist. An existing execution root is safe only when empty or when it contains the recognized execution layout. A missing derived execution directory is created only by an operation authorized to create execution artifacts; review, slice, and close operations must instead report their missing required artifact.

## Slice normalization

`SLICE` accepts one unsigned decimal number such as `3` or `03`, and normalizes it deterministically to `slice-03`. Reject empty, signed, negative, non-numeric, decimal, or otherwise ambiguous values; callers do not supply the `slice-` prefix.

`SLICES` accepts an explicit comma-separated list of those numbers. Normalize each member, remove duplicates while preserving first-seen order, and require at least two distinct slices. Never infer additional candidates.

Eligibility is derived from persisted open status, dependencies, and blockers; it is not an invocation input and never selects a slice. Block every slice operation without `SLICE`, including when one slice is eligible, and block `PARALLELIZE_SLICES` without `SLICES`.

## Execution root

Prefer the derived dedicated execution root. A `feature_spec.md` source uses its `execution/` child without modifying the source document or its `shared/` records. Another source uses the normalized sibling root.

```text
<execution-root>/
├── plan.md
├── plans/
│   ├── slice-01.md
│   └── ...
├── tasks.md
└── tasks/
    ├── slice-01.md
    └── ...
```

## Relative Paths

Every persisted path is relative to the file that contains it.

- In `execution/plan.md`, a colocated source can be `../feature_spec.md`.
- In `execution/plans/slice-01.md`, the same source can be `../../feature_spec.md`.
- In `execution/tasks/slice-01.md`, the detailed plan must be `../plans/slice-01.md`.
- In `execution/tasks/slice-01.md`, the same source can be `../../feature_spec.md`.

Do not store absolute paths unless the caller explicitly requires a non-portable workspace.

## Responsibilities

- `plan.md`: compact global context, slice order, dependency map, per-slice summaries, coverage references, likely areas, parallel notes, and detailed plan paths. It is not progress state.
- `plans/slice-NN.md`: detailed design for one observable delivery slice, not a checklist.
- `tasks.md`: compact global operational progress and the canonical `[ ]` or `[x]` row for each slice.
- `tasks/slice-NN.md`: detailed checklist and evidence record for one slice.

The source remains authoritative for requirements. Reference requirements by stable IDs or exact locations; do not copy full criteria into every execution artifact. Likely areas guide exploration but are not an absolute allowlist. Record and assess discovered expansion before acting, and block when it changes authorized requirements, scope, dependencies, or strategy.
