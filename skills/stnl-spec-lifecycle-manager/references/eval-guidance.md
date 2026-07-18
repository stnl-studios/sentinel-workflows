# File Purpose Header

```yaml
purpose: Define executable evaluation expectations for the lifecycle contract.
status: not_applicable
read_when: Updating the skill, schema, templates, prompts, examples, parser, or structural checks.
do_not_read_when: Running an ordinary SPEC lifecycle operation.
contains: Executable case source, required assertions, quality categories, and regression signals.
owner: stnl-spec-lifecycle-manager
update_policy: Expand when a real regression exposes a missing invariant.
```

# Eval Guidance

`evals/cases.json` is the machine-consumed case catalog; `evals/eval-cases.md` is its human index. After a substantial lifecycle change, run these commands from the Sentinel Workflows repository root: `node --test scripts/test-lifecycle-contracts.mjs`; `node --test skills/stnl-spec-lifecycle-manager/runtime/test/core.test.mjs skills/stnl-spec-lifecycle-manager/runtime/test/lifecycle.test.mjs skills/stnl-spec-lifecycle-manager/runtime/test/readiness.test.mjs skills/stnl-spec-lifecycle-manager/runtime/test/closed-spec.test.mjs skills/stnl-spec-lifecycle-manager/runtime/test/publisher.test.mjs`; `node --test scripts/test-lifecycle-validator-adversarial.mjs scripts/test-lifecycle-readiness-adversarial.mjs scripts/test-lifecycle-renderer-adversarial.mjs`; `node --test scripts/test-lifecycle-distribution.mjs`; `node --test scripts/test-runtime-context-budget.mjs`; `node --test scripts/test-subagent-packages.mjs`; `bash scripts/test-validation-runner-contract.sh`; and `bash scripts/test-launcher-contract.sh`. Generated workspaces are isolated temporary fixtures.

Each case declares an operation label, generated fixture inputs, expected validity and status, allowed changes, expected IDs, expected links, and objective assertions. The contract runner performs deterministic fixture construction, structural validation, transition validation, and file-preservation checks. The embedded runtime suite separately owns safe-publication interruption simulation. Neither executes INIT, RESUME, READINESS, or CLOSE with a model end to end.

The runner verifies positive and negative parser cases, immutable IDs and tombstones, mode boundaries, read-only `LOCAL`/`GLOBAL` READINESS simulation, coverage, references, exact close authority, safe publication, and external immutability. Dedicated suites verify readiness-attestation schema/snapshot binding at renderer and publisher, exact deterministic CLOSE feature bytes, rejected OS metadata, non-cooperative publisher conflict recovery, persistent-lock exclusion, crash recovery, and runtime budgets. The lifecycle invocation has no model runner. For `INIT`, `SPEC_PATH` designates a nonexistent directory; existing paths are blocked. Launcher validation separately verifies explicit inputs and transient context.

Fail a change that requires a delivery workflow, invents requirements, changes stable IDs, accepts item YAML, hides a relevant decision, mutates during READINESS, makes closure depend on operational proof, loses canonical content, weakens coverage or inverse-link validation, or modifies an external directory.
