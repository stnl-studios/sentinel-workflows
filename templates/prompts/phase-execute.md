Use `stnl-spec-execution-manager`.

SPEC: `{{SPEC_PATH}}`
Execution root: `{{EXECUTION_ROOT}}` (optional; infer it when blank).
Phase: `{{PHASE_NUMBER}}`
Read only the phase artifacts, relevant SPEC sections, and related code. Implement only this phase, run directly related tests, complete individual tasks, and record changed files, tests, and a concise diff summary in the phase artifacts.
Do not conclude or validate the phase, commit, start another phase, or perform future-phase work.
If session context exceeds about 40%, compact it before continuing, preserving only the phase, relevant decisions, changed files, tests, and pending work. Use `/compact` in Claude Code or the environment's equivalent mechanism.

Reply only with:
- implementation status;
- changed files;
- tests;
- blockers.
