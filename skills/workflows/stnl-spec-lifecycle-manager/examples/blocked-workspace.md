# File Purpose Header

```yaml
purpose: Show a valid blocked SPEC, an in-scope requirement, an open blocking question, and a partially blocked active criterion.
status: blocked
read_when: A concrete blocked INIT or question-link shape is needed.
do_not_read_when: A ready or closed SPEC example is needed.
contains: Compact blockers, one in-scope R, one active AC, one open blocking Q, coverage, and inverse links.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with question, relationship, workspace, and readiness policies.
```

# Blocked Workspace

```text
specs/onboarding-improvements/
├── feature_spec.md
└── shared/
    ├── requirements.md
    ├── acceptance-criteria.md
    └── questions.md
```

The `feature_spec.md` File Purpose Header has `status: blocked`. Its only materialized paths and blockers are:

```yaml
artifacts:
  requirements: shared/requirements.md
  acceptance_criteria: shared/acceptance-criteria.md
  questions: shared/questions.md
```

```yaml
blocking_questions: [Q-001]
documentary_gaps: []
```

The requirement remains in scope:

### R-001 — Visitante elegível cria conta e perfil

- status: in_scope

Quando um visitante elegível envia dados válidos no cadastro, o produto cria uma conta e um perfil persistidos.

The criterion remains active while partially blocked and owns the only requirement-to-criterion coverage direction:

### AC-001 — Cadastro cria conta e perfil

- status: active
- verifies: [R-001]
- blocked_by: [Q-001]

Dado um visitante em `/signup`, quando envia dados válidos, então uma conta e um perfil persistidos ficam visíveis na confirmação.

The `questions.md` File Purpose Header also has `status: blocked`:

### Q-001 — Segmento elegível para cadastro

- status: open
- classification: blocking
- blocks: [AC-001]

#### Pergunta

Quais segmentos de visitante podem concluir o cadastro?

#### Por que importa

A resposta define a regra de elegibilidade observada por AC-001.

#### Resolução

Pendente.

For a global documentary blocker, use the same open blocking shape with `blocks: []`; it still blocks readiness. An open `non_blocking` question omits `blocks` and does not appear in `blocking_questions`.
