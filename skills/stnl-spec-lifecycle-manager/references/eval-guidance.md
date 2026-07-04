# File Purpose Header

```yaml
purpose: Define lightweight evals for evolving this skill safely.
load_when: Changing the skill or checking whether a new version regressed.
do_not_load_when: Running ordinary INIT, RESUME, PLANNING, or CLOSE work.
contains: Eval objectives, must-pass cases, scoring hints, and token-bloat checks.
owner: stnl-spec-lifecycle-manager
update_policy: Expand as real failures are observed.
```

# Eval Guidance

Evaluate this skill with representative tasks before adopting changes.

## Must-pass behaviors

1. The skill triggers for spec lifecycle tasks.
2. The skill does not trigger for implementation-only tasks.
3. `INIT` asks crucial questions for vague specs.
4. `INIT` does not over-ask when the request is clear.
5. IDs are canonical and stable.
6. `PLANNING` blocks open questions.
7. `PLANNING` does not replan.
8. `RESUME` can re-slice without renumbering IDs.
9. `qa_checklist` does not become a test plan.
10. `CLOSE` removes execution history.
11. Finalizer updates only a completed slice.
12. Failed external execution does not update the spec.
13. Traceability matrix stays compact and ID-only.
14. Token bloat is controlled.

## Suggested scoring categories

| Category | What to score |
|---|---|
| Outcome | Correct file/spec result for the MODE. |
| Process | Followed MODE restrictions and gates. |
| Style | Markdown structure, concise prose, canonical IDs. |
| Safety | No bypass of questions, no partial execution recording. |
| Efficiency | No redundant sections, no verbose duplicated artifact text. |

## Regression examples

Fail the skill if it:

- creates `F-001`;
- creates `Slice 1`;
- renumbers `AC-003` to `AC-002`;
- marks a slice ready while `Q-001` is open;
- writes Jest/Cypress scenarios in `qa_checklist`;
- stores failed coder attempts in `feature_spec.md`;
- keeps completed slice history in the final closed spec;
- loads examples or references unrelated to the active MODE.
