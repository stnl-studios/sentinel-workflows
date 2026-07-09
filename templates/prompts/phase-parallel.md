# File Purpose Header

```yaml
purpose: Prompt template for safely coordinating explicitly parallel phases.
status: ready
read_when: Two or more planned phases are proposed for concurrent delivery.
do_not_read_when: Phases share files, schemas, contracts, mutable state, or ordering dependencies.
contains: Parallel safety check, worker boundaries, and coordinator update rules.
owner: stnl-spec-execution-manager
update_policy: Update when parallel safety policy changes.
```

Use stnl-spec-execution-manager to coordinate phases <NN list> concurrently only after confirming they share no files, schemas, migrations, lockfiles, contracts, global fixtures, generated code, persistent state, common resources, ordering dependency, or tests that mutate shared resources.

Each worker reads only its detailed plan, detailed task file, linked requirements records, and related code, and updates only `tasks/tasks-NN.md`. Workers return compact diff and evidence summaries. A coordinator integrates results and updates `plan.md` and `tasks.md` one phase at a time.
