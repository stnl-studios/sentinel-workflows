# File Purpose Header

```yaml
purpose: Show a valid blocked SPEC, an open question, and a partially blocked active criterion.
status: blocked
read_when: A concrete blocked INIT or question-link shape is needed.
do_not_read_when: A ready or closed SPEC example is needed.
contains: Minimum tree, compact blockers, one active AC, one open Q, and inverse links.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with question, relationship, workspace, and readiness policies.
```

# Blocked Workspace

```text
specs/onboarding-improvements/
├── feature_spec.md
└── shared/
    ├── acceptance-criteria.md
    └── questions.md
```

The `feature_spec.md` File Purpose Header has `status: blocked`. Its only materialized paths and blockers are:

```yaml
artifacts:
  acceptance_criteria: shared/acceptance-criteria.md
  questions: shared/questions.md
```

```yaml
open_questions: [Q-001]
broken_references: []
documentary_gaps: []
```

The criterion remains active while partially blocked:

### AC-001 — Cadastro cria conta e perfil

- status: active
- blocked_by: [Q-001]

Dado um visitante em `/signup`, quando envia dados válidos, então uma conta e um perfil persistidos ficam visíveis na confirmação.

The `questions.md` File Purpose Header also has `status: blocked`:

### Q-001 — Segmento elegível para cadastro

- status: open
- blocks: [AC-001]

#### Pergunta

Quais segmentos de visitante podem concluir o cadastro?

#### Por que importa

A resposta define a regra de elegibilidade observada por AC-001.

#### Resolução

Pendente.

For a global documentary blocker, use the same open shape with `blocks: []`; it still blocks readiness.
