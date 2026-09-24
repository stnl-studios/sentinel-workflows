Use `stnl-plan-reviewer`.
OPERATION=REVIEW_PLAN
SPEC_PATH={{SPEC_PATH}}

Before invoking candidate validation or the plan-path serializer, run the deterministic plan-candidate preparer at `__PLANNER_PLAN_CANDIDATE_PREPARER__` against the isolated candidate execution root:

`node "__PLANNER_PLAN_CANDIDATE_PREPARER__" --candidate-execution-root "<absolute candidate execution root>"`

This prevalidation producer copies the exact File Purpose Header from the canonical plan templates when a candidate artifact has no header marker. For an existing header, it requires one complete block with exactly the template field set and one valid `status: draft|ready`, then serializes all fixed metadata values and field order from the template while preserving that status. Missing, duplicate, or unknown fields; missing or invalid status; and malformed, misplaced, or duplicate markers block before candidate validation. It never edits live artifacts and is not a repair after candidate rejection.

Raw global `Expected areas` code spans are semantic repository-relative selections, not persisted artifact-relative claims. Only after the deterministic serializer succeeds, recompute every reviewed plan claim from its declaring artifact with `path.relative(path.dirname(artifact), physicalTarget)`, normalize `/`, compare by `realpath` with the physical target, and return `BLOCKED` without publication if any claim differs; never approve a plan claim that resolves to another path, and do not run this artifact-relative readback against the raw semantic input before serialization.

The candidate global plan `Expected areas` code spans are the reviewed semantic physical-target selections. Before invoking candidate validation, run the deterministic serializer at `__PLANNER_PLAN_PATH_SERIALIZER__` against the exact `SPEC_PATH` above and the isolated candidate execution root:

`node "__PLANNER_PLAN_PATH_SERIALIZER__" --spec-path "{{SPEC_PATH}}" --candidate-execution-root "<absolute candidate execution root>"`

The serializer must generate every detailed-plan `Likely Areas` path mechanically from the corresponding global target using the declaring detailed-plan directory, then invoke the official `validateExecutionCandidate` authority with the same `SPEC_PATH` and candidate root before returning `PASS`. Its successful JSON reports `candidateValidation.state` and `candidateValidation.currentFingerprint`. Do not separately assemble or invoke the candidate-validator command. A serialization or strict candidate-validation failure returns non-zero and blocks publication; never alter or re-present a rejected candidate as a repair.

The reviewed global code spans are repository-root-relative semantic physical targets before serialization (for example, `test/cli.test.mjs`), not persisted paths relative to `execution/plan.md`. The serializer writes canonical artifact-relative claims, then validates the candidate using the exact same `SPEC_PATH` and candidate root it already received. Keep conceptual descriptions outside code spans. Publish only after the serializer reports successful strict candidate validation and the resulting state is the approved state for this operation.

Contexto adicional (opcional):
