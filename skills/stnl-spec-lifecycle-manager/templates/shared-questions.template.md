# File Purpose Header

```yaml
purpose: Store open, resolved, bypassed, or dropped questions for <feature>.
status: blocked
read_when: INIT/RESUME/PLANNING checks blockers or a slice links Q-### IDs.
do_not_read_when: The index says there are no materialized questions.
contains: Q-### artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT/RESUME may update; execution agents cannot bypass questions.
```

# Questions

### Q-001 - <Question title>

```yaml
id: Q-001
status: open
question: <Smallest decision needed.>
why_it_matters: <Why this affects scope, behavior, risk, or implementation.>
blocks: [SL-001]
resolution: null
resolved_by: null
linked_decision: null
```
