# File Purpose Header

```yaml
purpose: Keep slice execution compact through selective reading and non-duplicated evidence.
status: not_applicable
read_when: An execution operation risks broad reads, repeated prose, or unnecessary evidence.
do_not_read_when: A tiny selected correction already has all needed context.
contains: Reading rules, compact global artifact limits, evidence budgets, and closure reading limits.
owner: stnl-spec-execution-manager
update_policy: Change when selective-reading policy changes.
```

# Token Economy

Execution artifacts exist to make clean sessions possible without replaying prior history.

Keep `plan.md` as compact global context and `tasks.md` as compact global progress. They must not duplicate detailed plans, detailed task checklists, full requirements, extensive evidence, or session history.

For one slice, start with:

- `plan.md`;
- `tasks.md`;
- selected `plans/slice-NN.md`;
- selected `tasks/slice-NN.md`;
- referenced requirements only;
- related code and tests discovered from the selected artifacts.

Do not load future slice details, completed slice task records, all requirements artifacts, all tests, previous conversation summaries, or the whole repository without a concrete reason.

Detailed evidence stays concise: changed areas, scope expansion if any, divergences, test result, validation verdict, findings, corrections, revalidation, diff summary, and final result. Do not store command output, failed attempts, chats, permanent handoffs, or repeated criteria.
