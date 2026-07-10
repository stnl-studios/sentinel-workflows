# File Purpose Header

```yaml
purpose: Show lossless documentary consolidation and external-directory preservation.
status: closed
read_when: A concrete CLOSE sequence or durable final-item example is needed.
do_not_read_when: The workspace is still blocked or only one active item needs reading.
contains: Before and after trees, preservation assertions, and durable canonical structures.
owner: stnl-spec-lifecycle-manager
update_policy: Keep aligned with the close policy, final schema, and external boundary.
```

# CLOSE Result

Before CLOSE:

```text
specs/invitation-expiration/
├── feature_spec.md
├── shared/
│   ├── acceptance-criteria.md
│   ├── decisions.md
│   ├── constraints.md
│   ├── risks.md
│   └── questions.md
└── execution/
    └── retained-record.txt
```

The lifecycle manager validates all gates, builds the final document, compares every durable item and main section, then removes `shared/`. Only afterward does it validate the closed form and compare the external snapshot.

After CLOSE:

```text
specs/invitation-expiration/
├── feature_spec.md
└── execution/
    └── retained-record.txt
```

The final `feature_spec.md` keeps the objective, context, final scope, exclusions, requirements, rules, contracts, AC prose, and complete durable records. Active blocker metadata is absent; durable provenance remains through decisions, references, and question resolution. For example:

### D-001 — Expiração usa relógio do serviço

- status: accepted
- references: [C-001]

#### Contexto

Clientes podem ter relógios divergentes.

#### Decisão

O serviço compara `expires_at` com seu próprio relógio UTC.

#### Impacto

O resultado é determinístico para todos os clientes.

### R-001 — Atraso de propagação do relógio

- status: active
- impact: medium
- references: [C-001, AC-001]

#### Risco

Deriva entre nós pode produzir respostas diferentes na borda do prazo.

#### Mitigação

Sincronizar nós e monitorar deriva, preservando o risco como ativo enquanto material.

A resolved question linked to D-001 remains in `Durable Resolved Questions` with its `Pergunta`, `Por que importa`, and explicit `Resolução`. The byte content of `execution/retained-record.txt` is unchanged; no implementation evidence participates in the gate.
