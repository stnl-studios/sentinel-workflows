Use `stnl-spec-execution-manager`.

SPEC: `{{SPEC_PATH}}`
Execution root: `{{EXECUTION_ROOT}}` (optional; infer it when blank).
Close policy: `{{CLOSE_POLICY}}` (`validate_only`, `consolidate_and_keep`, or `consolidate_and_remove`).
Perform operational closure using the selected policy. Verify the SPEC, plan, tasks, code, tests, and findings from evidence rather than checkboxes alone; block on insufficient evidence.
Persist audit details in the artifacts and do not repeat the audit in chat.

Reply only with:
- status;
- applied policy;
- blockers;
- relevant final files.
