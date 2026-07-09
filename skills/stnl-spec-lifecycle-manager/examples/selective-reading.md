# File Purpose Header

```yaml
purpose: Demonstrate selective reading for one slice in a modular workspace.
status: example
read_when: The agent needs to understand minimal slice package assembly.
do_not_read_when: The task is only about template shape or CLOSE output.
contains: Step-by-step selective loading and an in-memory package example.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with references/token-economy.md.
```

# Selective Reading Example

For `specs/invitation-expiration/`:

1. Read `feature_spec.md`.
2. Find `next_candidate_slice: SL-001`.
3. Read `slices/SL-001.md`.
4. Extract linked IDs:

```yaml
linked_acceptance_criteria: [AC-001, AC-002]
linked_decisions: [D-001]
linked_constraints: [C-001]
linked_risks: [R-001]
linked_questions: []
```

5. In `shared/acceptance-criteria.md`, locate headings `AC-001` and `AC-002`; read only those blocks.
6. In `shared/decisions.md`, read only `D-001`.
7. In `shared/constraints.md`, read only `C-001`.
8. In `shared/risks.md`, read only `R-001`.
9. Do not load lifecycle files during implementation unless the role needs them.
10. Do not create a permanent context package file.

In-memory handoff:

```yaml
slice: SL-001
slice_file: slices/SL-001.md
acceptance_criteria: [AC-001, AC-002]
constraints: [C-001]
risks: [R-001]
decisions: [D-001]
resolved_questions: []
validation_hints:
  - Expired invitations must be observably rejected by the existing acceptance flow.
context_hints:
  - invitation domain/model
  - invitation acceptance flow
```
