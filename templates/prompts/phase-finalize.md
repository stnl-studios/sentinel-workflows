# File Purpose Header

```yaml
purpose: Prompt template for correction, revalidation, and evidence-based phase conclusion.
status: ready
read_when: A phase has a PASS verdict or focused validation findings.
do_not_read_when: Initial planning or standalone validation is requested.
contains: Correction boundary, revalidation, and index-update rules.
owner: stnl-spec-execution-manager
update_policy: Update when phase conclusion policy changes.
```

Use stnl-spec-execution-manager to conclude phase <NN> in <execution workspace>.

If validation reports findings, correct only those findings and necessary effects, run relevant tests, record the result, and obtain focused revalidation. Only after `PASS`, finish detailed evidence, mark this phase `[x]` in `tasks.md` and `plan.md`, add compact consistent summaries, and materialize the next safe detailed task file. Do not reopen a concluded phase. Report a requirements divergence instead of continuing after a scope, dependency, or strategy change.
