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

`evals/cases.json` is the machine-consumed case catalog; `evals/eval-cases.md` is its human index. Run `python3 scripts/test-spec-lifecycle.py` after any substantial lifecycle change. Generated workspaces are isolated temporary test fixtures.

Each case declares an operation label, generated fixture inputs, expected validity and status, allowed changes, expected IDs, expected links, and objective assertions. The runner performs deterministic fixture construction, structural validation, transition simulation, and file-preservation checks. It does not execute INIT, RESUME, PLANNING, or CLOSE with a model end to end.

The runner verifies positive and negative parser cases, mode-boundary invariants, read-only PLANNING simulation, readiness structure, structural references, external narrative references, active risks, close preservation, and external-directory immutability. The lifecycle invocation has no model runner. For `INIT`, `SPEC_PATH` must designate a directory path that does not exist. Block an existing file or directory, including a directory without `feature_spec.md`; if `feature_spec.md` already exists, direct the caller to `RESUME`. Launcher validation separately verifies the minimal `SPEC_PATH` contract and that optional context does not become persisted authority.

Fail a change that requires a delivery workflow, invents requirements, changes stable IDs, accepts item YAML, hides a relevant decision, mutates during PLANNING, makes closure depend on operational proof, loses durable content, weakens inverse-link validation, or modifies an external directory.
