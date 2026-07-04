# File Purpose Header

```yaml
purpose: Keep specs and skill usage token-efficient.
load_when: Any MODE risks producing verbose, duplicated, or context-heavy output.
do_not_load_when: A tiny correction can be made without structural context.
contains: Token economy rules, lazy-loading behavior, duplication control, and compact-reference patterns.
owner: stnl-spec-lifecycle-manager
update_policy: Change when token-cost strategy changes.
```

# Token Economy

The goal is to maximize signal and minimize repeated prose.

## Core rules

1. Prefer canonical IDs over repeated descriptions.
2. Keep `SKILL.md` short; put detailed rules in references.
3. Load references only for the active MODE.
4. Keep traceability matrix ID-only.
5. Do not copy acceptance criteria into slices.
6. Do not copy slice descriptions into `qa_checklist`.
7. Do not preserve failed execution attempts in the spec.
8. Do not store chat transcript fragments in the spec.
9. Remove operational history in `CLOSE`.
10. Keep File Purpose Headers short.

## Slice context package

For external execution of a slice, provide only:

- the current `SL-###`;
- linked `AC-###` items;
- linked `C-###` constraints;
- linked `R-###` risks;
- linked `D-###` decisions;
- linked `Q-###` only if already resolved and durable;
- validation hints;
- context hints;
- minimal neighboring slice information only when dependency requires it.

Do not load the full spec during implementation unless the slice context is demonstrably insufficient.

## Compact traceability

Good:

```markdown
| Slice | ACs | Constraints | Risks | Decisions | Questions |
|---|---|---|---|---|---|
| `SL-001` | `AC-001`, `AC-002` | `C-001` | `R-001` | `D-001` | — |
```

Bad:

```markdown
| Slice | ACs |
|---|---|
| `SL-001` | `AC-001`: Full repeated paragraph of behavior... |
```

## Compact QA checklist

Good:

```yaml
qa_checklist:
  spec_quality_gate:
    status: blocked
    blockers: [Q-001]
    checks:
      open_questions: fail
      traceability: pass
```

Bad:

```markdown
The acceptance criteria seem good because the invitation creation behavior is described in detail and the user can probably...
```

## Completion summary budget

A completed slice summary should usually fit in 3-6 bullets or a compact YAML block.

Do not include:

- failed attempts;
- exact code diff summaries unless durable;
- test command output;
- long reviewer commentary;
- speculative future work.

## Optional fields

Do not include empty optional fields unless absence matters.

Good:

```yaml
linked_risks: [] # No material risks identified.
```

Bad:

```yaml
linked_risks: []
linked_questions: []
linked_decisions: []
notes: ""
extra_notes: ""
misc: ""
```

## CLOSE compaction

`CLOSE` should aggressively compact. If a detail does not help future maintenance, validation, extension, or business understanding, remove it.
