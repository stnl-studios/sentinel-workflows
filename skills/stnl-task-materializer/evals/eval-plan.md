# File Purpose Header

```yaml
purpose: Define regression expectations for task materialization.
status: not_applicable
read_when: Changing MATERIALIZE_TASKS, task templates, or approval checks.
do_not_read_when: Materializing tasks under unchanged contracts.
contains: Approved-plan prerequisites, fidelity, binary progress, and mutation boundaries.
owner: stnl-task-materializer
update_policy: Extend when task materialization loses approved-plan fidelity.
```

# MATERIALIZE_TASKS Eval Cases

1. Rejects missing, draft, unapproved, or inconsistent plans before writing.
2. Creates exactly one global row and one detailed task file per approved slice.
3. Uses only binary global checkboxes and preserves serial dependencies.
4. Never changes planning artifacts or invents work.
5. Rejects every existing or partial task set and preserves its bytes.
6. Validates and renders the entire set before publishing, leaving no partial artifacts on failure.
7. Renders separate append-only implementation and findings check sections with global sequential IDs, automatic round `N/3`, four auxiliary statuses, read-only discovery actions and sources, verification types, non-applicability rationale, no-verification-command confirmation, and between-round correction evidence.
8. Keeps Validation Attempts and the Effective Validation Base separate from every auxiliary check record.
