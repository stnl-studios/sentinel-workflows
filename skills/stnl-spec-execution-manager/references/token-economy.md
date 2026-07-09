# File Purpose Header

```yaml
purpose: Keep delivery work compact through selective reading and non-duplicated evidence.
status: not_applicable
read_when: A delivery operation risks broad reads, repeated prose, or unnecessary evidence.
do_not_read_when: A tiny selected correction already has all needed context.
contains: Reading rules, compact-index limits, evidence budgets, and closure compaction rules.
owner: stnl-spec-execution-manager
update_policy: Change when the delivery economy policy changes.
```

# Token Economy

Keep `plan.md` and `tasks.md` as discovery indices, not duplicated detailed records. Refer to source requirements by stable identifiers or explicit locations rather than copying them.

For one phase, start with its requirements references, detailed plan, detailed tasks, and related code. Do not load future plans, completed task files, all requirements artifacts, or the repository without a concrete reason.

Detailed evidence stays concise: changed areas, test result, validation verdict, findings and corrections, revalidation, and a short diff summary. Do not store command output, failed attempts, chats, session summaries, permanent handoffs, or repeated criteria.
