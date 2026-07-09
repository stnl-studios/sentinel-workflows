Use `stnl-spec-execution-manager`.

Execution root: `{{EXECUTION_ROOT}}` (optional; infer it when blank).
Phases: `{{PARALLEL_PHASES}}`
Validate independence before starting workers. Block parallelism for shared files, migrations, schemas, lockfiles, common contracts, global fixtures, generated code, shared persistent state, or ordering dependencies.
Create one subagent or independent context per eligible phase. Each worker reads only its phase plan, tasks, related criteria, and relevant code, and updates only its detailed phase artifact.
Workers must not concurrently update `plan.md` or `tasks.md`; the coordinator integrates results and serially updates the indices. Do not create commits or reproduce every worker output.

Reply only with:
- executed phases and result for each;
- conflicts;
- tests;
- blockers.
