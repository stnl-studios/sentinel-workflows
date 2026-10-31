# Sentinel Workflows — backlog

Este arquivo é o índice de prioridades e do estado macro. Ler o backlog não inicia trabalho nem autoriza execução. O plano detalhado, decisões e resumos de aceite de P1-B ficam em [maintenance/P1-B-PLANO.md](maintenance/P1-B-PLANO.md). Resultados reproduzíveis permanecem nos artefatos de evidência referenciados por esse plano; não duplicá-los aqui.

## Prioridades

| ID | Prioridade / estado | Escopo e próximo passo |
| --- | --- | --- |
| BL-01 | P0 concluída | Manutenção pragmática; não reabrir automaticamente. Aceite em [maintenance/p0-summary.md](maintenance/p0-summary.md). |
| BL-02 | P0 concluída | Clareza e eficiência do workflow; evoluções posteriores não desfazem esse aceite. |
| BL-03 | P1-A concluída no recorte acordado | Installer global e README integrados pela PR #2. Limites da certificação dos clientes ficam separados do aceite da fase. |
| BL-08 (ID documental proposto) | P1-B concluída; U5 encerrada | Entrega integrada em `main` pela PR [#7](https://github.com/stnl-studios/sentinel-workflows/pull/7), merge SHA `2f452961ef0b4b02e33c98f058d7c17ee10ff077`. U6 Claude segue como acompanhamento pós-entrega, sem bloquear P1-B. |
| BL-04 | Adiada / sob demanda | Roadmap, principalmente melhoria de layout. |
| BL-05 | Adiada / sob demanda | Refinar user stories e preparar tasks para boards; são diferentes das Tasks internas do workflow. |
| Sem ID novo | Sob demanda | Melhorias no runbook quando selecionadas. A validação formal do workflow continua separada. |
| BL-06 | Futuro | Orquestração geral; o manager de benchmark não comprova esse epic. |
| BL-07 | Última etapa | Sentinel Platform; não antecipar infraestrutura. |

P1-A e P1-B foram priorizadas em sequência, sem dependência técnica obrigatória. Não há outra entrega ativa em paralelo.

## P1-B — situação em 2026-10-31

**Aceite:** P1-B encerrada após a integração em `main` e a confirmação por leitura de volta da PR #7 e do merge SHA `2f452961ef0b4b02e33c98f058d7c17ee10ff077`. U6, o teste nativo de Claude por Aj, permanece pendente como acompanhamento pós-entrega; não bloqueia P1-B e pode motivar um ajuste focal se surgir defeito concreto.

**Estado atual:** U3 concluída no escopo funcional aceito. H1 (`aae1e46`) teve aceite funcional em 3/3; H2 não foi medido. U3.18 segue com aceite funcional A/B/C em 3/3 FULLs, mas a medição permanece incompleta, não qualificada e adiada. U4.3 teve resultado focal Codex `COMPLETE`/`PASS`; isso não demonstra uso real Claude, qualificação universal ou medição de H2.

| Unidade | Estado | Saída / limite |
| --- | --- | --- |
| U1 — Preparação conjunta | Entregue, com PASS histórico no recorte | Sem recertificação global automática. |
| U2 — Continuidade e recuperação | Entregue, com PASS histórico no recorte | Evidências posteriores complementam, sem apagar limites históricos. |
| U3 — Qualificação e QA | Concluída no escopo funcional aceito | Medição incompleta permanece adiada; não iniciar nova campanha por inferência. |
| U4 — Equalização Claude | Concluída nos recortes U4.1–U4.3 | Igualdade offline e prova focal Codex não equivalem a teste nativo Claude. |
| U5 — Entrega revisada | Concluída; P1-B encerrada | PR #7 integrada em `main`; merge SHA `2f452961ef0b4b02e33c98f058d7c17ee10ff077` confirmado por leitura de volta. Não havia checks remotos reportados; não declarar CI remoto aprovado. |
| U6 — Teste Claude por Aj | Pendente, pós-entrega | Acompanhamento separado; registrar observações e propor ajuste focal se necessário. Não é gate para fechar P1-B. |

### Limites e referências

- U3.18: [aceite funcional e medição adiada](maintenance/P1-B-PLANO.md#u318). Não alegar economia ou comparabilidade de métricas.
- U4.3: [disposição e alcance da prova focal](maintenance/P1-B-PLANO.md#u43-disposicao-de-impacto-e-requalificacao). Sem nova campanha, chamada de modelo, benchmark, push, PR ou merge nesta revisão local.
- U5: [sequência, critérios, autorizações e resultado](maintenance/P1-B-PLANO.md#u5). Merge confirmado; sem checks remotos reportados, portanto sem alegação de CI aprovado.
- U6: [teste Claude por Aj](maintenance/P1-B-PLANO.md#u6). Sem instalação nem uso Claude antecipados.

O plano detalhado é a fonte canônica dos históricos técnicos e decisões anteriores. Resumos superados ou contraditórios que antes estavam repetidos neste índice foram removidos; nenhum critério, ID de requisito P1B-01–09, decisão vigente ou resultado aceito foi alterado por essa limpeza.

O registro da correção local `af2aeb5` para `stnl-task-materializer` saiu do backlog ativo: esse workflow foi retirado do catálogo atual, a branch indicada no registro não existe neste checkout e o caminho do runtime não está no produto. Não há ação pendente de publicação associada a esse item.
