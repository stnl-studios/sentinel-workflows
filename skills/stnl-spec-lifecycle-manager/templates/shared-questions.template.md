# File Purpose Header

```yaml
purpose: Template for materialized blocking and resolved questions.
status: blocked
read_when: INIT, RESUME, or a readiness gate needs a question resolution.
do_not_read_when: The SPEC confirms no materialized question is relevant.
contains: Q canonical artifacts only.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME resolve questions explicitly and preserve durable resolutions.
```

# Questions

### Q-001 - <Question title>

```yaml
id: Q-001
status: open
question: <Smallest decision needed.>
why_it_matters: <Behavior, scope, or risk impact.>
blocks: [AC-001]
resolution: null
resolved_by: null
linked_decision: null
```
