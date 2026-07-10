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

The runner consumes `evals/cases.json`, creates isolated input workspaces from the skill's real templates when applicable, executes validator or transition operations, and asserts validity, documentary status, IDs, links, allowed file changes, and expected error signals.

The catalog covers: ready and blocked INIT; RESUME resolving a question and creating a durable decision; read-only PLANNING; non-observable criteria; missing internal IDs; qualified external IDs; divergent inverse links; active mitigated risks; complete and blocked CLOSE; durable-content loss; `execution/` preservation and mutation detection; item YAML rejection; duplicate body IDs; duplicate headings; prefix mismatch; missing metadata; invalid status; and stale `open_questions`.

Every case targets the single current contract described by the skill references.
