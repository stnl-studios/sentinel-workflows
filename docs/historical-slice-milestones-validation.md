# Historical slice milestones: validation boundaries

Base: `046597071a376d658cbcbdea8c4cbee74def2165`. This change preserves authenticated execution and formal PASS as temporal milestones. Later authorized changes belong to the current slice; unexplained drift is not historical approval.

## Coverage

- Four-checkpoint simulation: execution alone cannot release slice 3; slice 2 formal PASS can.
- Operational Initial and converted evidence: successor overlap, NEEDS_FIX/APPLY, blocked retry, exact stale-set selection, Q18/Q19, and exhausted recovery budgets.
- Proven file/directory creation and removal, foreign changes, missing provenance, and wrong modes.
- CLOSE reuses criterion coverage and archives exact execution evidence before retirement; interruptions retain recovery authority.

These are automated runtime/fixture tests, not a live conversation campaign in installed Claude or Codex. Distribution and contract parity do not prove identical model behavior.

## Baseline test corrections

Three converted APPLY tests expected a missing first-formal anchor after the test had created one. The existing composer deliberately retains `attempt-01`; the corrected tests must prove exact retention and require formal validation after APPLY. Negative coverage must actually remove or corrupt the anchor rather than expect a correctly retained anchor to be absent.

V08 expected pruning that conflicts with required first-formal and BLOCKED transition evidence. Retaining this evidence is an integrity property, not a defect to fix by weakening the compositor.

## Legacy witness boundary: V09

`scripts/test-current-validation-evidence.mjs` V09 reproduces a baseline compatibility failure: consecutive native BLOCKED records whose captured origins omit `otherDeliveryWork` reach `assertBlockedFormalTransition`, which compares the missing values using the canonical JSON comparator. `undefined` is not canonical JSON, so the operation fails closed with `INVALID_CURRENT_IMAGE: canonical: plain object required`.

The official current producer captures an `otherDeliveryWork` array. Modern operational blocked-retry tests cover that path. The replay-positive test now models that explicit current producer witness locally, while a dedicated negative covers missing, one-sided, malformed, and divergent witnesses. The runtime rejects absent or non-array witnesses explicitly with `EVIDENCE_INCOMPLETE`; it never maps them to an empty array. The old incidental canonicalization failure was reproduced on base `0465970`.

Accepting such legacy records would require an explicit compatibility design that preserves cross-delivery protection. This change does not add that compatibility. Preserve their evidence and report the blocked transition; do not manufacture witnesses or discard history. Required first-formal retention does not grant replay permission to an old owner.

## Claude/Codex distribution check

Read-only installation-plan comparison found byte-identical shared content for 14 skills and 229 resources across Codex and Claude targets. The seven workflow packages passed self-containment checks; subagent-package, execution-contract, and repository-contract tests passed (36/36). Native agent descriptors remain platform-specific (Codex TOML versus Claude Markdown/tools/model configuration). No installation or actual model/app execution was performed by this validation.

## Stable-source run before the V09 correction

On `97edfac3a981e6e82ffe97a5b77af78b01f14dff`, all `scripts/test-current-*.mjs` files ran together with Node test concurrency 4: **1203 tests, 1202 passed, 1 failed, 0 skipped/cancelled** (1591.57 seconds). The only failure was the unchanged V09 legacy case described above. The detached run completed with exit code 1. An earlier connection-interrupted partial run is not counted as final evidence.

The final CLOSE/distribution/budget/catalog group passed **77/77**. The corrected converted-APPLY anchor tests passed **4/4**, including real missing/corrupt anchor negatives. No runtime was relaxed to remove a baseline failure. This is not an all-green release result; integration/installation remains a separate decision.
