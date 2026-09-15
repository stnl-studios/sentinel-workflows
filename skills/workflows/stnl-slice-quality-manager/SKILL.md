---
name: stnl-slice-quality-manager
description: Delegate independent validation, own formal finding disposition, and terminalize one current-authority slice on PASS or explicitly ACCEPTED quality debt.
validation-runtime: runtime/run-validation-session.mjs
validation-runner-protocol: stnl-validation-runner/v11
validation-harness-protocol: stnl-validation-harness/v10
validation-capability-identity: sha256:a0fe14e372062808af664e0bf2525f18f1e89f04b0bafbf4f0f3c24d78499320
---

# stnl-slice-quality-manager

## Purpose

Run only `VALIDATE_SLICE`. Check deterministic prerequisites, obtain an independent logical plan, invoke the installed owner bridge so the harness executes it, request independent post-harness assessment, then persist candidate-validated evidence and dispositions. Complete only from a valid `PASS` or `ACCEPTED` assessment bound to that sealed evidence.

## Inputs

- `SPEC_PATH`: required. A directory must contain `feature_spec.md` and uses its `execution/` child; that file path resolves identically; another requirements file uses sibling `<stem>-execution/`. Block every other form.
- `SLICE`: required and explicit; normalize one unsigned decimal number to `slice-NN` and never infer it.
- Optional `BYPASS_GATE=<prior-record-NN>/gate-NN` with `BYPASS_REASON=<accepted risk>` (or an equally explicit operator request) authorizes review of only that concrete optional gate. Revalidate first; persist the actual operator and authorization reference, never infer blanket consent.
- The launcher supplies the platform-specific runner invocation. This skill contains no vendor-specific invocation syntax.

## Authority

The independent runner owns discovery, the logical plan and required post-harness technical assessment. The packaged harness owns physical execution and sealed evidence. This skill owns Validation Attempts, formal finding disposition, candidate validation and authorized publication; it never substitutes plan acceptance or exit 0 for the independent verdict.

Execution preflight is read-only. An accepted mandatory resume includes a structured `MANDATORY_RECOVERY` record; an incompatible request includes structured `RECOVERY_TARGETS`. Preserve those fields exactly. Only when preflight reports a mechanical violation for the exact `Findings IDs` alias or the exact historical `Check discovery sources` / `Check discovery actions` pair may this skill explicitly run `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --repair-known-contract` once and repeat the original preflight; every other contract violation blocks.

## Minimum Reads

- `tasks.md`, selected detailed plan and task file, referenced requirements;
- `references/validation-base.md` before persisting a result;
- local `references/execution-record-schema.md` before interpreting or changing findings, divergences, attempts, or terminal state;
- Implementation Test Evidence and Findings Test Evidence for the selected slice;
- only artifacts needed for cheap prerequisites and faithful persistence.

## Quality decisions and resume

Read the Quality gate observations, revalidation and acceptance contract in `references/execution-record-schema.md`. Send prior blockers, bypass requests and causal evidence to the runner. The shared runtime's `REVALIDATION_REQUIRED` is a work item, not a new BLOCKED verdict. Revalidate current working-tree conditions before considering bypass or REPLAN. Preserve failed command exits; independent external debt is non-blocking. Unknown causality needs investigation. Operator acceptance must target one previously observed optional gate and is persisted as ACCEPTED, never PASS. Divergence revalidation must preserve its original Kind and Required authority operation: only observational/none can become non_blocking, and authority/lifecycle/structural/required conditions must be objectively absent to resolve. Keep the original history and ownership; structural authority changes remain with their owners.

## Validation bridge, harness and evidence

A new plan uses exactly `protocol:{runner:"stnl-validation-runner/v11",harness:"stnl-validation-harness/v10",capability:<this loaded skill's validation-capability-identity>}` and every command declares `executionEnvironment`. Missing, unknown, mixed, stale or incoherent identity and missing environment fail closed before verification. The v11 runner change is intentionally incompatible; historical v10 evidence remains readable but cannot authorize new execution/publication. Only the owner bridge transports the exact opaque harness envelope. Candidate validation rejects result-shaped planner output, raw exits/counts/textual verdicts, reconstructed provenance and any provenance without the matching v10 harness receipt.

The loaded location for this `SKILL.md` is the sole bootstrap authority. After planning, the owner immediately invokes:

`node "<SKILL_ROOT>/runtime/resolve-validation-runtime.mjs" --execute-plan <SPEC_PATH> '<PLAN_JSON>'`

This bridge invocation is authorized Sentinel orchestration, not direct toolchain execution. `<SKILL_ROOT>` comes only from the loaded resource, never cwd, HOME, an installation convention, operator input or delegated payload. The bridge validates plan schema, owner operation, loaded runner capability, authority/revision, slice, formal round, lifecycle, explicit environment and bounded outputs; obtains prior evidence from lifecycle; resolves the harness from its own `import.meta.url`; handshakes; builds the low-level request; and invokes the harness. The harness independently repeats lifecycle checks. Existing source-symlink, host/Docker authority, toolchain/cache, sandbox, exact-write, no-fallback, cleanup and bounded retry protections remain unchanged.

An optional Docker `cacheVolumes` capability may select only an exact named-volume mapping authenticated from that service and the same Compose file with an explicit project name. Authenticate local volume labels/driver/scope, copy it once into a temporary safe snapshot with a disposable helper, reject links or special entries, mount only the snapshot read-only, and fingerprint metadata plus content. Never mount the live volume or infer cache, network, environment, certificates, or other Compose capability.

Persist the resolver's exact opaque `Evidence provenance` transport without parsing or reconstruction. Invalid, side-effecting, sandbox-boundary-blocked, stale, unclean or non-equivalent replay evidence can only create `BLOCKED` and cannot create a finding, PASS, ACCEPTED or Effective Validation Base. `VALIDATION_SIDE_EFFECT` identifies an observed protected mutation; a denied-before-mutation access with no protected delta uses `SANDBOX_BOUNDARY_BLOCKED` and deterministic structured `boundaryViolations`. An authenticated harness pre-check `INVALID/INFRASTRUCTURE_BLOCKED/NONE` result is persisted in a `Kind: infrastructure` Delegation Blocker with no `attempt-NN`; evidence from a validation that entered check execution is persisted in its attempt. New findings include immutable `Kind: implementation_defect|code_regression` and `Evidence identity` bound to their origin attempt. `code_regression` requires an equivalent replay anchored to a prior `VERIFIED` persisted evidence record; an invalid reproduction has conclusion `NONE`. On PASS/ACCEPTED, provenance subjects exactly own the Effective Validation Base files and are rechecked before candidate publication. A resolved Delegation Blocker remains historical provenance while current effective blockers are projected independently and clear only after valid resumed evidence.

## VALIDATE_SLICE

Before content reads or delegation, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> VALIDATE_SLICE <SLICE>`. Its state-derived recovery target is authority: when it blocks, preserve the exact concrete legal operation and slice instead of inferring either from the current request. Require all artifacts, matching current requirements fingerprint and plan revision, completed serial dependencies and mandatory checklist, an open non-superseded slice, and valid check/attempt/finding/blocker structure. A normally consistent `IMPLEMENTED_AWAITING_VALIDATION`, `FINDINGS_CORRECTED`, `VALIDATION_BLOCKED`, `IMPLEMENTATION_RETRY_EXHAUSTED`, or `FINDINGS_RETRY_EXHAUSTED` permits this operation. If terminal implementation evidence is paired with an incomplete mandatory checklist, validation remains blocked even when the observed state has one of those names: preserve the runtime's exact mandatory `stnl-slice-executor / EXECUTE_SLICE / slice-NN` recovery target. After that slice becomes complete, normal validation authority returns without manual lifecycle edits. `VALIDATION_NEEDS_FIX` also permits independent revalidation of manual corrections. An active divergence permits only the runtime-selected revalidation before any authority change; it cannot be ignored. The first invocation is `initial`; every later invocation is `revalidation`, including after `BLOCKED`. A terminal `PASS`, `ACCEPTED`, or `SUPERSEDED` slice is immutable. Block before invoking the runner on structural failures; persisted observational blockers are sent for fresh revalidation, not returned as a fresh verdict.

The main context does not run toolchains directly, redo validation, soften findings, promote `BLOCKED`, or emit another technical verdict. It may and must invoke the packaged bridge after accepting the independent plan.

Prior test evidence is auxiliary, never a formal verdict. Pass it to the runner with the selected diff and scope for independent discovery and planning. The runner reviews prior non-applicability, coverage, risks and overlaps but does not execute. After the bridge/harness returns sealed evidence, send only its compact summary, evidence ID and plan identity back to the independent role for the required `stnl-validation-assessment/v1`; do not send or ask it to copy the opaque envelope. The assessment evaluates actual exits, coverage, Gate assessments, findings/dispositions and overlap without executing checks, reconstructing evidence or publishing. Neither plan acceptance nor auxiliary success guarantees a formal verdict.

Start planning in a new independent delegated session with no inherited conversation history, using the platform launcher supplied by the caller. Send only operation, `SPEC_PATH`, slice, current requirements fingerprint/revision, compact implementation/findings evidence, active/historical finding summary, existing attempt summary, changed scope/diff, overlaps, project references needed for discovery and necessary context. Never send loaded skill root, installation path, resolver/runtime filename, harness path, packaged schema path, prior evidence ID, conversation history or logs. Accept only `stnl-validation-plan/v1`; raw PASS/BLOCKED, exits, counts or provenance are malformed before bridge dispatch.

The bridge command returns only a compact summary plus `resultFile`; the sealed envelope and logs remain in that owner-private OS-temporary receipt. After it returns `ASSESSMENT_REQUIRED`, invoke the independent assessment phase once with only the compact summary, evidence ID and plan identity. This formal operation always requires post-execution interpretation; do not add assessment calls to mechanically conclusive auxiliary checks. Require assessment identity to match operation, slice, round, plan identity and evidence ID. A stale or divergent assessment blocks candidate composition; the owner never silently replaces the runner capability with its own. Deliver the assessment to `node "<SKILL_ROOT>/runtime/resolve-validation-runtime.mjs" --assess-result <resultFile> '<ASSESSMENT_JSON>'`; use only the replacement `resultFile` returned by that command.

Classify initialization/transport failure, authenticated harness pre-check infrastructure/source-isolation `BLOCKED`, evidence-bearing runner `BLOCKED`, malformed runner output, `NEEDS_FIX`, and verification-command failure separately. For initialization or transport failure only, retry once with a new independent session and the same minimum payload. These technical starts do not create or consume an `attempt-NN`, change `initial` to `revalidation`, or authorize validation in the main context. If both starts fail, persist the canonical active `Delegation Blocker` singleton with `Kind: initialization` and stop in `RUNNER_INITIALIZATION_BLOCKED`. Malformed started output persists it with `Kind: malformed-output` and stops in `RUNNER_RESULT_BLOCKED`. A contract-valid pre-check infrastructure result receives no transport retry and persists exact `HEAD`, `Evidence provenance`, and authenticated code/message under `Kind: infrastructure`, with no attempt, then stops in `RUNNER_RESULT_BLOCKED`. Only the same operation/slice may resume directly at delegation; a later valid attempt resolves the singleton atomically.

For every valid assessment bound to evidence-bearing execution, append exactly one deterministic next `attempt-NN`. Commands, exits, HEAD, subjects, envelope and side effects come only from the bridge/harness; verdict, evidence summary, gates and finding dispositions come only from the assessment. Preserve every earlier attempt. Formal validation remains the only owner of finding state. Pre-check infrastructure stays outside attempts, and planning/transport/malformed output never fabricates one. The first formal `PASS` or `ACCEPTED` is terminal.

On `NEEDS_FIX`, validate and persist a complete deterministic disposition for every prior active finding: resolved findings receive a non-placeholder `Resolution` naming this attempt; superseded findings receive `Superseded by: finding-NN`; unresolved problems remain active. Append stable new findings for newly identified implementation problems with severity, state `active`, origin attempt, problem, evidence, impact, related authority, and expected correction. Leave the Effective Validation Base unchanged or absent, keep the global row `[ ]`, leave final result pending, report explicit `APPLY_FINDINGS`, and stop. An evidenced authority/scope/strategy gap is formal `BLOCKED`; REPLAN requires current causal evidence and proof that no in-scope correction is valid under the Gate assessments contract; it is never disguised as `NEEDS_FIX` and this skill does not create a divergence.

On `BLOCKED`, persist the current concrete cause and missing prerequisite, leave the Effective Validation Base unchanged or absent, keep the global row `[ ]`, do not convert the status, and report a repeat `VALIDATE_SLICE` after its external prerequisite or explicit `REPLAN` when authority is the blocker. Stop.

On `PASS` or `ACCEPTED`, in this same operation (substitute exact `ACCEPTED` for every result field when a valid bypass remains):

1. validate the current attempt output and the complete final manifest before any mutation;
2. require all original changes, corrections, necessary effects, removals, relevant tests, and prior-slice overlaps, with justified regressions for affected earlier behavior;
3. reject incomplete, malformed, duplicate, unsorted, contradictory, or workspace-inconsistent manifest data and never invent hashes or results;
4. append the current `PASS` or `ACCEPTED` attempt without overwriting history;
5. for ACCEPTED retain only findings matched by a current valid bypass; atomically change every other remaining applicable active blocking finding to `resolved` with a non-placeholder resolution naming this successful validation attempt, or to `superseded` with a valid same-kind pointer; reject PASS if any active blocking finding would remain;
6. create or replace the entire Effective Validation Base so its origin is this current `PASS` or `ACCEPTED` attempt; for a fileless slice persist exact `Files: none`, objective `Fileless reason`, and `Changed Areas: none` without inventing a path or hash;
7. confirm the mandatory checklist, no effective active blocking finding or divergence, valid hashes, authoritative exits reconciled under Gate assessments, and a consistent final result;
8. persist the final diff summary and exact `PASS` or `ACCEPTED` result and change exactly the selected global row from `[ ]` to `[x]` with the same exact validation/result;
9. stop without selecting another slice.

Compose all owner-held detailed/global changes and finding dispositions in an isolated complete execution candidate, then invoke `node "<SKILL_ROOT>/runtime/resolve-validation-runtime.mjs" --stage-candidate <SPEC_PATH> <resultFile> <CANDIDATE_EXECUTION_ROOT>`. This operation-specific helper inserts the attempt, sealed evidence and derived Effective Validation Base without exposing them to the model and runs the canonical candidate validator. Independently require the canonical final gate with `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>` before publication. Candidate invocation and publication ownership remain with this owner; this is contract/model enforced, while runtime parsing is strict but does not authorize unrelated diff. Rejection preserves live bytes. After successful candidate validation, publish only this operation's selected task and global row, then use the final handoff command as strict readback. Never finalize from a historical attempt or accept a base whose origin is `NEEDS_FIX` or `BLOCKED`. A `[x]` `PASS`/`ACCEPTED` slice has exactly one valid Effective Validation Base; a `[x]` `SUPERSEDED` slice has no successful-validation requirement and is immutable; an open slice has `Final Result: pending`.

## Allowed Effects

- obtain exactly one planning result and, after evidence-bearing harness execution, exactly one independent assessment from the configured runner; each phase permits only the bounded initialization/transport start specified above;
- update validation-owned sections in `tasks/slice-NN.md`;
- transition finding states only as part of one valid formal attempt;
- update exactly one `tasks.md` row only after valid `PASS` or `ACCEPTED` persistence.
- use temporary support files only outside the SPEC and execution root; never create scratch scripts, manifests, checklists, or ad hoc reports inside them.

## Blocks

Block invalid inputs, missing prerequisites, stale requirements authority, invalid attempt/finding history, any still-valid blocking divergence after revalidation, a non-canonical execution path or unsafe reserved SPEC entry reported by preflight, unavailable runner after the single technical retry, malformed runner output, incomplete Effective Validation Base data, incomplete finding dispositions, overlap without justified regressions, or persistence inconsistency. Arbitrary lifecycle-external or user-owned SPEC-root siblings are allowed and preserved. Never fall back to validation in the main context, delete an unknown path, or allocate an attempt for transport failure.

## Output

After persistence, execute `node "<SKILL_ROOT>/runtime/validate-execution-state.mjs" <SPEC_PATH> --handoff-after VALIDATE_SLICE`. Report `PASS`, `ACCEPTED`, `NEEDS_FIX`, or `BLOCKED`, persisted evidence paths, whether the slice was completed, the runtime's normal handoff, every legal operation, and mandatory recovery as separate fields. Stop.
