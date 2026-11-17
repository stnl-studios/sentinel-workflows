# Historical slice milestones: validation boundaries

Base: `046597071a376d658cbcbdea8c4cbee74def2165`. This change preserves authenticated execution and formal PASS as temporal milestones. Later authorized changes belong to the current slice; unexplained drift is not historical approval.

## Scope

The delivery targets new SPECs created by the current workflow. Historical milestones are earlier approved slices within that workflow, not support for obsolete record formats. Legacy migration and legacy-specific recovery are excluded.

## Coverage

- Four-checkpoint simulation: execution alone cannot release slice 3; slice 2 formal PASS can.
- Operational Initial and converted evidence: successor overlap, NEEDS_FIX/APPLY, blocked retry, exact stale-set selection, Q18/Q19, and exhausted recovery budgets.
- Proven file/directory creation and removal, foreign changes, missing provenance, and wrong modes.
- CLOSE reuses criterion coverage and archives exact execution evidence before retirement; interruptions retain recovery authority.

These are automated runtime/fixture tests, not a live conversation campaign in installed Claude or Codex. Distribution and contract parity do not prove identical model behavior.

## Baseline test corrections

Three converted APPLY tests expected a missing first-formal anchor after the test had created one. The existing composer deliberately retains `attempt-01`; the corrected tests must prove exact retention and require formal validation after APPLY. Negative coverage must actually remove or corrupt the anchor rather than expect a correctly retained anchor to be absent.

V08 expected pruning that conflicts with required first-formal and BLOCKED transition evidence. Retaining this evidence is an integrity property, not a defect to fix by weakening the compositor.

## Current witness contract: V09

The current native producer always captures an `otherDeliveryWork` array. V09's former positive fixture omitted this required field and no longer represented that producer. Its positive replay coverage now uses the explicit current witness, retaining old-owner, changed-bytes and changed-request replay rejections.

Dedicated negative tests cover missing, one-sided, malformed and divergent witnesses. Missing/non-array witnesses are rejected explicitly with `EVIDENCE_INCOMPLETE`, never inferred as an empty sibling set. Different observations remain stale. No fallback, migration or legacy recovery was added. Required first-formal retention never grants replay permission to an old owner.

## Claude/Codex distribution check

Read-only installation-plan comparison found byte-identical shared content for 14 skills and 229 resources across Codex and Claude targets. The seven workflow packages passed self-containment checks; subagent-package, execution-contract, and repository-contract tests passed (36/36). Native agent descriptors remain platform-specific (Codex TOML versus Claude Markdown/tools/model configuration). No installation or actual model/app execution was performed by this validation.

## Stable-source run before the V09 correction

On `97edfac3a981e6e82ffe97a5b77af78b01f14dff`, all `scripts/test-current-*.mjs` files ran together with Node test concurrency 4: **1203 tests, 1202 passed, 1 failed, 0 skipped/cancelled** (1591.57 seconds). The only failure was the former V09 positive fixture, corrected to represent the current producer as described above. The detached run completed with exit code 1. An earlier connection-interrupted partial run is not counted as final evidence.

The final CLOSE/distribution/budget/catalog group passed **77/77**. The corrected converted-APPLY anchor tests passed **4/4**, including real missing/corrupt anchor negatives. No runtime was relaxed to remove a baseline failure. That earlier run was not the final release result.


## Final current-workflow result

On `fd99eb165df59331525724bee0f7d0a66fb38048`, all `scripts/test-current-*.mjs` files ran together with Node test concurrency 4: **1204/1204 passed, zero failures, skips or cancellations** (1665.14 seconds), exit code 0. No source changed during this run. This documentation update does not change the tested runtime or tests.

After the V09 correction, validation evidence passed **15/15**, operational BLOCKED retries **5/5**, and distribution/budget/catalog checks **70/70**. Independent review found no concrete issue. Earlier CLOSE/distribution/budget/catalog coverage passed **77/77**. No real Claude or Codex model sessions were run, and no global installation or main integration was performed by this task.

## Current CLOSE continuation coverage

An authorized CLOSE request instructs the principal skill to resume an existing operation before selecting the smallest legal `normalHandoff` (EXECUTE, APPLY_FINDINGS or VALIDATE) within approved Plan/Tasks and existing budgets. The deterministic CLOSE publisher itself does not start an agent or manufacture evidence; it publishes only authenticated COMPLETE.

Three additional current Initial controller-integration tests passed, including an independent rerun (**3/3**, no skips). They explicitly drive the controllers with fixture semantic responses while real verification checks execute: absent execution/validation prevents CLOSE; the normal handoff chain reaches COMPLETE; NEEDS_FIX requires APPLY and new validation; BLOCKED prevents closing; resume/publication do not rerun captured checks, verified by a counter; archived evidence stays byte-exact. They do **not** simulate an LLM deciding what to do after the user says CLOSE.

The documentation/contract update passed **263/263** focused tests; final platform contracts passed **36/36** and read-only install-plan comparison again found **14 skills / 229 resources** byte-identical. Runtime files remain byte-identical to the full 1204/1204 tested revision. The three added tests were run separately; no claim of a new combined 1207-test run is made.
