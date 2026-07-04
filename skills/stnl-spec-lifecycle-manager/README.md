# stnl-spec-lifecycle-manager Skill

A slice-driven skill package for creating, resuming, planning, and closing high-quality feature specifications.

## Main entry

- `SKILL.md`

## Supporting files

- `references/`: lazy-loaded operating rules.
- `templates/`: feature spec template.
- `examples/`: short examples used only when format clarification is needed.
- `evals/`: lightweight checks for skill evolution.

## Core concept

The canonical unit of work is a slice: `SL-001+`.

A slice should fit one complete external agent round:

```text
orchestrator -> planner -> test planner -> coder -> validator -> reviewer -> finalizer
```

If the round fails, the spec is not updated. If the round succeeds, the finalizer updates only the completed slice and durable linked artifacts.

## Modes

- `INIT`: create a new spec.
- `RESUME`: resume or replan an existing spec.
- `PLANNING`: validate readiness; do not replan.
- `CLOSE`: create one clean final `feature_spec.md`.
