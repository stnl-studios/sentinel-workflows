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

## Known legacy limitation: V09

`scripts/test-current-validation-evidence.mjs` V09 reproduces a baseline compatibility failure: consecutive native BLOCKED records whose captured origins omit `otherDeliveryWork` reach `assertBlockedFormalTransition`, which compares the missing values using the canonical JSON comparator. `undefined` is not canonical JSON, so the operation fails closed with `INVALID_CURRENT_IMAGE: canonical: plain object required`.

The official current producer captures an `otherDeliveryWork` array. Modern operational blocked-retry tests cover that path. This does not establish compatibility for old captured origins that lack the witness. The same V09 failure was reproduced on base `0465970`; its assertion remains enabled. No runtime fallback maps missing evidence to an empty witness.

Handling such legacy records requires an explicit compatibility design that preserves cross-delivery protection. Until then, preserve their evidence and report the blocked transition; do not manufacture witnesses, discard history, or claim the full suite is green.

## Claude/Codex distribution check

Read-only installation-plan comparison found byte-identical shared content for 14 skills and 229 resources across Codex and Claude targets. The seven workflow packages passed self-containment checks; subagent-package, execution-contract, and repository-contract tests passed (36/36). Native agent descriptors remain platform-specific (Codex TOML versus Claude Markdown/tools/model configuration). No installation or actual model/app execution was performed by this validation.
