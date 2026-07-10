# File Purpose Header

```yaml
purpose: Template for materialized canonical questions with explicit open global blocking state.
status: blocked
read_when: INIT, RESUME, or a readiness gate needs a question or its resolution.
do_not_read_when: The SPEC confirms no materialized question is relevant.
contains: Q canonical artifacts only, with an open global blocker.
owner: stnl-spec-lifecycle-manager
update_policy: INIT and RESUME maintain blockers, inverse links, and explicit final resolutions.
```

# Questions

### Q-001 — {{ITEM_TITLE}}

- status: open
- blocks: []

#### Pergunta

{{CONTENT}}

#### Por que importa

{{CONTENT}}

#### Resolução

Pendente.
