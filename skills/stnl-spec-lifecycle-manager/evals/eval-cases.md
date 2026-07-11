# File Purpose Header

```yaml
purpose: Index the executable regression catalog for the independent SPEC lifecycle.
status: not_applicable
read_when: Changing lifecycle contracts, templates, examples, prompts, parser, or validators.
do_not_read_when: Running an ordinary SPEC lifecycle operation.
contains: Runner command, machine catalog location, coverage map, and failure policy.
owner: stnl-spec-lifecycle-manager
update_policy: Keep synchronized with cases.json and the executable runner.
```

# Executable Eval Cases

Run:

`python3 scripts/test-spec-lifecycle.py`

The runner consumes `evals/cases.json`, creates isolated fixture workspaces from helpers and real templates where applicable, runs deterministic validators or transition simulations, and asserts validity, documentary status, IDs, links, allowed file changes, and expected error signals. It does not execute lifecycle modes with a model end to end.

The catalog covers deterministic fixtures for ready, blocked, and draft INIT shapes; isolated materialization of each shared template with only its indexed category; RESUME-style question resolution and durable-decision transformations; read-only PLANNING simulation; ready-without-active-AC rejection; structural AC narrative checks without keyword observability; explicit placeholder rejection; technical angle-bracket syntax acceptance; missing internal IDs; qualified external IDs; divergent inverse links; active mitigated risks; canonical shared-file structure; block semantics for open versus final questions; complete and blocked CLOSE; durable-content loss; `execution/` preservation and mutation detection; item YAML rejection; duplicate body IDs; duplicate headings; prefix mismatch; missing metadata; invalid status; stale `open_questions`; and artifact-index consistency.

The lifecycle invocation itself has no model runner. For `INIT`, `SPEC_PATH` must designate a directory path that does not exist. Block an existing file or directory, including a directory without `feature_spec.md`; if `feature_spec.md` already exists, direct the caller to `RESUME`.

Every case targets the single current contract described by the skill references. `validate-targets.sh` separately checks the minimal launcher contract, including transient optional context and the absence of duplicated mode rules.
