Use `stnl-spec-execution-manager`.

SPEC: `{{SPEC_PATH}}`
Phase: `{{PHASE_NUMBER}}`
Commit type: `{{COMMIT_TYPE}}` (optional; choose the correct conventional type when blank).
Confirm the phase has `PASS` and is concluded, inspect `git status`, and include only changes belonging to this phase. Do not include unrelated changes, modify code, close execution, or start another phase.

Reply exactly `Commit created: <short hash> <message>`, or only the blocker when it is unsafe to commit.
