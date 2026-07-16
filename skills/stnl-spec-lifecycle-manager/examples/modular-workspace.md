# File Purpose Header

```yaml
purpose: Show a valid ready modular SPEC with explicit requirement coverage, qualified external references, and an active mitigated risk.
status: ready
read_when: A concrete ready workspace or canonical item example is needed.
do_not_read_when: Only a blocked or closed shape is needed.
contains: Materialized tree, compact index, in-scope R, verifying AC, decision-linked question, external reference, and RK.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with schemas, relationships, and readiness gates.
```

# Ready Modular Workspace

```text
specs/invitation-expiration/
├── feature_spec.md
└── shared/
    ├── requirements.md
    ├── acceptance-criteria.md
    ├── decisions.md
    ├── constraints.md
    ├── risks.md
    └── questions.md
```

The feature header has `status: ready`, `blocking_questions: []`, no gaps, and an index containing exactly the six files above.

### R-001 — Convite expirado não cria participação

- status: in_scope

Um convite expirado segundo a autoridade temporal do serviço deve ser rejeitado sem criar participação.

### AC-001 — Convite expirado é rejeitado

- status: active
- verifies: [R-001]
- references: [D-001, C-001, RK-001]

Ao receber um convite cujo `expires_at` já passou segundo o relógio UTC do serviço, a API rejeita a aceitação com o envelope público de convite expirado e não cria participação.

The external origin `initial-scaffold/D-011` remains qualified in this narrative and is not treated as a missing local decision.

### D-001 — Expiração usa relógio do serviço

- status: accepted
- references: [C-001]

#### Contexto

Clientes podem ter relógios divergentes.

#### Decisão

O serviço compara `expires_at` com seu próprio relógio UTC.

#### Impacto

O resultado é determinístico para todos os clientes.

### Q-001 — Autoridade do relógio

- status: resolved
- classification: blocking
- resolved_by: decision
- linked_decision: D-001

#### Pergunta

Qual relógio determina a expiração?

#### Por que importa

A escolha altera o resultado observado por AC-001.

#### Resolução

D-001 estabelece o relógio UTC do serviço como autoridade.

### RK-001 — Atraso de propagação do relógio

- status: active
- impact: medium
- references: [C-001, AC-001]

#### Risco

Pequena deriva entre nós pode produzir respostas diferentes na borda do prazo.

#### Mitigação

Sincronizar nós, monitorar deriva e aceitar a tolerância documentada sem retirar a relevância do risco.
