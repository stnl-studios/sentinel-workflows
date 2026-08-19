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
│   ├── requirements.md
│   ├── acceptance-criteria.md
│   ├── decisions.md
│   ├── constraints.md
│   ├── risks.md
│   └── questions.md
└── execution/
    └── retained-record.txt
```

The lifecycle manager validates all gates, creates the external attestation, builds the final document, compares every canonical item and durable feature section, then removes `shared/`. The publisher revalidates the attestation, exact rendered feature bytes, absence of ignored OS metadata, closed form, and protected external snapshot before terminal publication.

After CLOSE:

```text
specs/invitation-expiration/
├── feature_spec.md
└── execution/
    └── retained-record.txt
```

The final `feature_spec.md` keeps the objective, context, final scope, exclusions, complete canonical requirements, rules, contracts, AC prose, and every canonical record from the source. Active blocker metadata is absent; durable provenance remains through `verifies`, decisions, references, and question resolution. For example:

### R-001 — Convite expirado não cria participação

- status: in_scope

Um convite expirado segundo a autoridade temporal do serviço deve ser rejeitado sem criar participação.

### D-001 — Expiração usa relógio do serviço

- status: accepted
- references: [C-001]

#### Contexto

Clientes podem ter relógios divergentes.

#### Decisão

O serviço compara `expires_at` com seu próprio relógio UTC.

#### Impacto

O resultado é determinístico para todos os clientes.

### RK-001 — Atraso de propagação do relógio

- status: active
- impact: medium
- references: [C-001, AC-001]

#### Risco

Deriva entre nós pode produzir respostas diferentes na borda do prazo.

#### Mitigação

Sincronizar nós e monitorar deriva, preservando o risco como ativo enquanto material.

Every final question, including one linked to D-001, remains in `Durable Resolved Questions` with its classification, `Pergunta`, `Por que importa`, and explicit `Resolução`. Merely copying an answer elsewhere does not authorize deletion. The byte content of `execution/retained-record.txt` is unchanged; no implementation evidence participates in the gate.
