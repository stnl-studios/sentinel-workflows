Use `stnl-spec-execution-manager` only when phase validation returned `NEEDS_FIX`.

SPEC: `{{SPEC_PATH}}`
Execution root: `{{EXECUTION_ROOT}}` (optional; infer it when blank).
Phase: `{{PHASE_NUMBER}}`
Read pending findings from the phase artifact; do not ask for them to be copied here. Correct only those findings and necessary effects, without silently expanding scope, then rerun relevant tests and update evidence and tasks.
Request focused revalidation in a subagent or independent context when available, using a suitable lower-cost model when appropriate. After revalidation `PASS`, conclude the phase and update execution indices; do not commit or start another phase.
If initial validation was `PASS`, do not use this prompt: record `revalidation: not_required` instead.

Reply only with correction count, tests, revalidation result, final phase state, and blockers.
