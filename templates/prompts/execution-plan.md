Use `stnl-execution-planner`.
OPERATION=PLAN
SPEC_PATH={{SPEC_PATH}}

Before invoking candidate validation or the plan-path serializer, run the deterministic plan-candidate preparer at `__PLANNER_PLAN_CANDIDATE_PREPARER__` against the isolated candidate execution root:

`node "__PLANNER_PLAN_CANDIDATE_PREPARER__" --candidate-execution-root "<absolute candidate execution root>"`

This prevalidation producer copies the exact File Purpose Header from the canonical plan templates when a candidate artifact has no header marker. For an existing header, it requires one complete block with exactly the template field set and one valid `status: draft|ready`, then serializes all fixed metadata values and field order from the template while preserving that status. Missing, duplicate, or unknown fields; missing or invalid status; and malformed, misplaced, or duplicate markers block before candidate validation. It never edits live artifacts and is not a repair after candidate rejection.

Raw global `Expected areas` code spans are semantic repository-relative selections, not persisted artifact-relative claims. Only after the deterministic serializer succeeds, recompute every plan claim from its declaring artifact with `path.relative(path.dirname(artifact), physicalTarget)`, normalize `/`, compare by `realpath` with the physical target, and return `BLOCKED` without publication if any claim differs; never publish a plan claim that resolves to another path, and do not run this artifact-relative readback against the raw semantic input before serialization.

The global plan `Expected areas` code spans are the model's semantic physical-target selections. Before invoking candidate validation, run the deterministic serializer at `__PLANNER_PLAN_PATH_SERIALIZER__` against the exact `SPEC_PATH` above and the isolated candidate execution root:

`node "__PLANNER_PLAN_PATH_SERIALIZER__" --spec-path "<exact SPEC_PATH above>" --candidate-execution-root "<absolute candidate execution root>"`

The serializer must generate every detailed-plan `Likely Areas` path mechanically from the corresponding global target using the declaring detailed-plan directory, then invoke the official `validateExecutionCandidate` authority with the same `SPEC_PATH` and candidate root before returning `PASS`. Its successful JSON reports `candidateValidation.state` and `candidateValidation.currentFingerprint`. Do not separately assemble or invoke the candidate-validator command. A serialization or strict candidate-validation failure returns non-zero and blocks publication; never alter or re-present a rejected candidate as a repair.

In the global plan's `Expected areas` cell, each code span is the semantic physical implementation target relative to the repository root containing the real `.git` marker (for example, `test/cli.test.mjs`), not the final path relative to `execution/plan.md`. The serializer resolves that target and writes the canonical artifact-relative claim into the global plan and every detailed plan before candidate validation. Keep conceptual descriptions outside code spans.

If a model escapes a closing Markdown fence as a single trailing backslash immediately before that fence, the path serializer treats that character as delimiter syntax and removes it before semantic target resolution. Interior backslashes remain malformed path input and are rejected.

Contexto adicional (opcional):
