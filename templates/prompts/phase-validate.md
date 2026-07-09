Use `stnl-spec-execution-manager`.

SPEC: `{{SPEC_PATH}}`
Execution root: `{{EXECUTION_ROOT}}` (optional; infer it when blank).
Phase: `{{PHASE_NUMBER}}`
Validate in a subagent or independent context when available; use a suitable lower-cost model for mechanical review when appropriate. Review only this phase's diff against its SPEC references, plan, tasks, and executed tests.
Identify divergences, unmet criteria, missing tests, dead code, and out-of-scope changes. Do not modify code or correct findings; persist findings in the phase artifact.
On `PASS`, record `revalidation: not_required`, finalize the phase evidence, and update the execution indices. On `NEEDS_FIX`, record findings only.

Reply exactly `PASS`, or `NEEDS_FIX` followed only by numbered findings with problem, evidence, reference, and expected correction.
