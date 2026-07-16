# File Purpose Header

```yaml
purpose: Template for materialized canonical questions with explicit open global blocking state.
status: ready
read_when: INIT, RESUME, or a readiness gate needs a question or its resolution.
do_not_read_when: The SPEC confirms no materialized question is relevant.
contains: Q canonical artifacts only, with an open global blocker.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain blockers, inverse links, and explicit final resolutions.
```

# Questions

### Q-001 — Which clock determines expiration

- status: resolved
- classification: blocking
- resolved_by: decision
- linked_decision: D-001

#### Pergunta

Which clock determines whether an invitation is expired?

#### Por que importa

The answer changes the result observed by AC-001.

#### Resolução

D-001 explicitly establishes the service UTC clock as authority.

