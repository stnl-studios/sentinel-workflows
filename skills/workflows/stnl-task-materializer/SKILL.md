---
name: stnl-task-materializer
description: Atomically create initial tasks or commit an approved pristine replacement or append-only recovery extension.
---

# stnl-task-materializer

## Purpose

Run only `MATERIALIZE_TASKS`. Convert an approved initial plan or recovery revision into deterministic task artifacts without reinterpreting strategy or exploring implementation by default.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- Optional additional context may narrow formatting but cannot change the approved plan.

## Authority

The current approved `plan.md` and approved detailed plans are the only materialization authority. Their `Requirements authority` fingerprint and `Plan revision` must match current authority and the corresponding task references. Requirements clarify referenced acceptance only. This skill may create an initial task set, including from a reviewed planning-only replacement, atomically replace a wholly pristine canonical materialized plan/task set, or append one approved recovery extension. It may not alter requirements or code.

Execution preflight is read-only. Only when it reports a mechanical violation for the exact `Findings IDs` alias or the exact historical `Check discovery sources` / `Check discovery actions` pair may this skill explicitly run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --repair-known-contract` once and repeat the original preflight; every other contract violation blocks.

In checklist `expected areas`, wrap each concrete filesystem path in one Markdown code span and rebase it to the detailed task that will contain it; do not copy plan text with its old relative basis. Normalize `SPEC_PATH` with the exported `resolveExecutionWorkspace(SPEC_PATH)` authority in `runtime/execution-state.mjs`, use its returned `executionRoot`, and do not derive the execution workspace independently. Set `taskPath = path.join(executionRoot, "tasks", "slice-NN.md")`. Resolve each approved plan claim against the directory of the artifact that declares it to obtain `physicalTarget`, then recompute the task claim mechanically as `path.relative(path.dirname(taskPath), physicalTarget)`, normalized to `/`; do not shorten or algebraically edit the plan string. Keep conceptual labels outside code spans. Candidate validation rejects non-canonical, escaping, symlinked, execution-root, or accidental lifecycle-SPEC-local implementation targets without fallback or autocorrection.

The approved detailed-plan `Likely Areas` code spans are the semantic physical-target selections. Before candidate validation, run the deterministic `runtime/serialize-task-paths.mjs` producer boundary against the exact `SPEC_PATH` and isolated candidate execution root. It writes every task `Checklist` `expected areas` claim from the approved physical target using the final task artifact directory. A non-zero serializer result is `BLOCKED` without candidate validation or publication; never wait for validation to reject, repair after rejection, guess a target, or edit live artifacts. Historical task bytes must remain unchanged; ambiguous counts or semantic claims absent from the approved plan block.
The publication boundary invokes the same serializer again immediately before strict candidate validation. This publisher-owned pass is the final mechanical serialization gate and may only derive claims from the approved detailed-plan physical targets; it does not relax candidate validation or repair a rejected candidate.
Before creating or editing any task, run the deterministic `runtime/prepare-task-candidate.mjs --prepare --spec-path <SPEC_PATH>` boundary and use its exact absolute `candidateExecutionRoot` for every write, serializer invocation, candidate validation, and publication. It resolves the official execution workspace, creates an external isolated candidate, and copies the complete execution tree. Do not derive or reconstruct this root in model prose; a non-zero preparation result is `BLOCKED` before candidate validation.

## MATERIALIZE_TASKS

Before content reads or writes, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> MATERIALIZE_TASKS`. Require a complete approved current revision, matching fingerprints and revision fields, consistent slice sets/order/dependencies/scope/references, and a deterministic materialization mode.

For initial materialization, require no task artifact and create the full set once. A reviewed planning-only replacement is still initial materialization: it remains revision `1` and has no historical recovery fields. For pristine replacement, require the entire existing task set to be exactly `MATERIALIZED_PRISTINE`; stage and atomically replace only canonical plans and tasks with the approved replacement. For append-only recovery, preserve all historical artifacts byte-for-byte except the exact authorized supersession and divergence-disposition fields, append only newly approved monotonically numbered task files and rows, and commit the approved supersession mapping in the same atomic publication. That mapping alone may terminalize each named open prior slice by changing its global row to `[x]`, Validation and Result to `SUPERSEDED`, and its detailed Final Result to `SUPERSEDED` with `Superseded by: slice-NN`. When requirements authority changed, every non-terminal older-fingerprint slice must be so superseded and replaced. Prior `PASS` slices remain `PASS` and are covered by a new current-revision reconciliation/corrective slice.

The same append-only commit is the only owner allowed to change an applicable active divergence to `resolved` or `superseded`. Use local `references/execution-record-schema.md`: a resolved divergence gets a non-placeholder `Resolution` naming the committed plan revision and corrective/replacement slice; a superseded divergence points to a new same-kind `divergence-NN`. Lifecycle `RESUME` may correct external documentary authority, but does not change execution records; the approved replan commit performs the deterministic execution reconciliation. Every open slice containing an applicable active blocking divergence must be terminalized as `SUPERSEDED` with a current-revision replacement; never rewrite its old fingerprint/revision and never resume it under new authority. Reject the commit if an applicable active blocking divergence would remain without an explicit recovery owner.

    Validate every precondition and render the complete authorized candidate before publishing any artifact. The deterministic `runtime/publish-task-candidate.mjs` boundary invokes the official `node "runtime/validate-execution-state.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>` against that isolated complete execution candidate, rejects changes outside `plan.md`, `plans/`, `tasks.md`, and `tasks/`, copies bytes into regular independent files, atomically publishes the authorized tree, and performs strict readback before returning. This contract/model-owned publication boundary gives the runtime strict candidate-parsing authority, not an implicit repair or publication fallback. Candidate validation remains strict and runtime parsing does not relax the diff. A non-zero publisher result is `BLOCKED` without another publication attempt or repair after rejection. On failure, preserve the exact prepublication authorized set so no partial task/revision set remains, and remove only invocation-owned staging. Never touch a path outside the authorized candidate or publish through hard links.
The isolated candidate must begin as a complete copy of the live execution root, including `plan.md`, every `plans/slice-NN.md`, `tasks.md`, `references/`, and authorized historical task artifacts. Never stage only `tasks/`; initial materialization creates new tasks after the complete copy, and candidate validation must see the full plan/task execution tree.

Create exactly one `[ ]` row per newly active approved slice in `tasks.md`, using only `[ ]` and `[x]`. Its File Purpose Header, owner/status, primary H1, canonical table header/separator, row order/grammar, checkbox, detail mapping, Validation, and Result are machine authority; surrounding explanatory prose is editorial and never derives state. Fenced code and HTML comments cannot supply or mask that authority, and row-like pipe-delimited residue outside the table is invalid. Create each detailed task from the pristine template and persist exactly `- Requirements authority: sha256:<64hex>` and `- Plan revision: <positive integer>`. Each task must have an observable result, expected area, requirement reference, and coherent operational order. Include the pristine sections defined by the template and use `references/execution-record-schema.md` for later operational records. Keep the global index compact and details local.
Before candidate validation, read `templates/tasks.template.md` and copy its complete `# File Purpose Header` block unchanged into `execution/tasks.md`; preserve all seven ordered fields, their values, `owner: stnl-task-materializer`, and `status: ready`. Create each `tasks/slice-NN.md` from `templates/slice-tasks.template.md` with its complete File Purpose Header unchanged. A missing, truncated, reordered, or altered header is a malformed candidate and must be repaired before validation; never publish a partial task index.

## Minimum Reads

- `plan.md` and every approved detailed plan;
- only requirement excerpts needed to make acceptance objective;
- task templates when writing;
- `references/execution-record-schema.md` for pristine sentinels and committed supersession fields.

## Allowed Effects

- create the initial full task set, atomically replace a wholly pristine set, or append only an approved recovery extension and its supersession transitions.

## Blocks

Return `NEEDS_REPLAN` without writing when plans are missing, unapproved, stale, inconsistent, or cannot be converted without a new decision. Return `BLOCKED` without writing on a partial/malformed task set, an attempted pristine replacement after evidence, a non-monotonic extension, or any history mutation. Never repair a plan or delete operational history.

## Output

After successful publication, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after MATERIALIZE_TASKS`. Report materialization mode, current fingerprint/revision, created task paths, committed supersession mappings, slice count, the runtime's normal handoff, all legal operations, and any `NEEDS_REPLAN` reason. After initial/pristine materialization, the normal handoff is `stnl-task-reviewer / OPERATION=REVIEW_TASKS`; frontier-scoped `EXECUTE_SLICE` and `REPLAN` remain legal alternatives and are not promoted over that review. Recovery materialization with execution history follows the persisted frontier. Stop after `MATERIALIZE_TASKS`.
