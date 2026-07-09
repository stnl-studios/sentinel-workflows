# stnl-spec-lifecycle-manager Skill

A slice-driven skill package for creating, resuming, validating readiness, and closing modular feature specification workspaces.

## Main entry

- `SKILL.md`

## Supporting files

- `references/`: lazy-loaded operating rules, including the canonical workspace contract in `references/spec-workspace.md`.
- `templates/`: modular workspace templates.
- `examples/`: short examples used only when format clarification is needed.
- `evals/`: lightweight checks for skill evolution.

## Core concept

The live spec is a modular workspace. Operational `feature_spec.md` is a compact index; shared artifacts, slices, and lifecycle state live in separate files.

Default path when the consumer repository has no stronger convention:

```text
specs/<feature-slug>/
```

Canonical operational structure:

```text
specs/<feature-slug>/
├── feature_spec.md
├── shared/
├── slices/
└── lifecycle/
```

The canonical unit of work is a slice: `SL-001+`, stored in `slices/SL-###.md`.

A slice should fit one complete external agent round:

```text
orchestrator -> planner -> developer approval -> test-planner -> developer approval -> coder -> validator -> reviewer -> developer completion
```

If the round fails, the spec workspace is not updated. If Validator and Reviewer pass, the developer manually completes the slice by updating only the allowed spec workspace files with a compact completion summary and lifecycle/index consistency updates.

## Modes

- `INIT`: create a new modular spec workspace.
- `RESUME`: resume or replan an existing spec.
- `PLANNING`: validate readiness; do not replan.
- `CLOSE`: compact the workspace into one clean final `feature_spec.md` and remove operational directories.
