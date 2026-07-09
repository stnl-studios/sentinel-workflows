# File Purpose Header

```yaml
purpose: Keep modular spec workspaces and skill usage token-efficient.
load_when: Any MODE risks producing verbose, duplicated, or context-heavy output.
do_not_load_when: A tiny correction can be made without structural context.
contains: Selective reading rules, duplication control, in-memory slice package rules, and compact-reference patterns.
owner: stnl-spec-lifecycle-manager
update_policy: Change when token-cost strategy changes.
```

# Token Economy

The goal is to maximize signal and minimize repeated prose.

## Core Rules

1. Prefer canonical IDs over repeated descriptions.
2. Keep operational `feature_spec.md` as an index, not a content container.
3. Load references only for the active MODE.
4. Keep traceability ID/path-only.
5. Do not copy acceptance criteria into slices.
6. Do not copy artifact descriptions into `lifecycle/qa-checklist.md`.
7. Do not preserve failed execution attempts in the spec workspace.
8. Do not store chat transcript fragments.
9. Remove operational history in `CLOSE`.
10. Keep File Purpose Headers short and specific.

## Selective Reading

Default flow:

1. Read `feature_spec.md`.
2. Read `lifecycle/resume-notes.md` only when resuming or checking next-slice continuity.
3. Read the current `slices/SL-###.md`.
4. Extract linked IDs.
5. Read only linked blocks from shared files.
6. Load `lifecycle/traceability.md` or `lifecycle/qa-checklist.md` only when the role or MODE requires them.

When a shared file has many artifacts, locate headings by ID and read only the heading range for the linked artifact. Do not load the full shared file by default.

## In-Memory Slice Package

For external execution, the orchestrator provides a handoff package in memory:

```yaml
slice: SL-###
slice_file: slices/SL-###.md
acceptance_criteria: [AC-###]
constraints: [C-###]
risks: [R-###]
decisions: [D-###]
resolved_questions: [Q-###]
validation_hints: <from slice>
context_hints: <from slice>
dependencies: [SL-###]
```

Do not create a permanent `slice-context`, `context-package`, `handoff`, or similar repository file. Handoffs between agents are disposable and textual.

Reading the whole workspace is allowed only when a concrete reason shows the selective package is insufficient.

## Compact Traceability

Good:

```markdown
| Slice | Slice file | ACs | Constraints | Risks | Decisions | Questions |
|---|---|---|---|---|---|---|
| `SL-001` | `slices/SL-001.md` | `AC-001`, `AC-002` | `C-001` | `R-001` | `D-001` | - |
```

Bad:

```markdown
| Slice | ACs |
|---|---|
| `SL-001` | `AC-001`: Full repeated paragraph of behavior... |
```

## Compact QA Checklist

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

## Completion Summary Budget

A completed slice summary should usually fit in 3-6 bullets or a compact YAML block.

Do not include:

- failed attempts;
- exact code diff summaries unless durable;
- test command output;
- long reviewer commentary;
- speculative future work.

## Optional Files and Fields

Do not materialize empty shared files. Use explicit absence in `feature_spec.md`:

```yaml
risks:
  file: null
  count: 0
  materialized: false
```

Do not include empty optional fields in artifacts unless absence matters.

## CLOSE Compaction

`CLOSE` should aggressively compact. If a detail does not help future maintenance, validation, extension, or business understanding, remove it. A successful close leaves only one final `feature_spec.md` in the feature folder.
