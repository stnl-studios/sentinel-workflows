# File Purpose Header

```yaml
purpose: Template for materialized canonical questions with explicit final resolution.
status: ready
read_when: INIT, RESUME, or a readiness gate needs a question or its resolution.
do_not_read_when: The SPEC confirms no materialized question is relevant.
contains: Q canonical artifacts only, with a decision-resolved example.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain blockers, inverse links, and explicit final resolutions.
```

# Questions

### Q-001 — <Resolved question title>

- status: resolved
- blocks: [AC-001]
- resolved_by: decision
- linked_decision: D-001

#### Pergunta

<Smallest decision that was needed.>

#### Por que importa

<Durable impact of the answer.>

#### Resolução

<Explicit resolution represented by D-001.>
