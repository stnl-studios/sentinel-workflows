# Sentinel Workflows — backlog

Este arquivo é o índice de prioridades e do estado macro. Ler o backlog não inicia trabalho nem autoriza execução. O plano detalhado, decisões e resumos de aceite de P1-B ficam em [maintenance/P1-B-PLANO.md](maintenance/P1-B-PLANO.md). Resultados reproduzíveis permanecem nos artefatos de evidência referenciados por esse plano; não duplicá-los aqui.

## Prioridades

| ID | Prioridade / estado | Escopo e próximo passo |
| --- | --- | --- |
| BL-01 | P0 concluída | Manutenção pragmática; não reabrir automaticamente. Aceite em [maintenance/p0-summary.md](maintenance/p0-summary.md). |
| BL-02 | P0 concluída | Clareza e eficiência do workflow; evoluções posteriores não desfazem esse aceite. |
| BL-03 | P1-A concluída no recorte acordado | Installer global e README integrados pela PR #2. Limites da certificação dos clientes ficam separados do aceite da fase. |
| BL-08 (ID documental proposto) | P1-B em andamento; U5.0 em revisão local | U3 aceita no escopo funcional; U4 concluída nos recortes descritos no plano; concluir U5 com entrega revisada, gates do PR e merge/readback em `main`. |
| BL-04 | Adiada / sob demanda | Roadmap, principalmente melhoria de layout. |
| BL-05 | Adiada / sob demanda | Refinar user stories e preparar tasks para boards; são diferentes das Tasks internas do workflow. |
| Sem ID novo | Sob demanda | Melhorias no runbook quando selecionadas. A validação formal do workflow continua separada. |
| BL-06 | Futuro | Orquestração geral; o manager de benchmark não comprova esse epic. |
| BL-07 | Última etapa | Sentinel Platform; não antecipar infraestrutura. |

P1-A e P1-B foram priorizadas em sequência, sem dependência técnica obrigatória. Não há outra entrega ativa em paralelo.

## P1-B — situação em 2026-10-30

**Aceite vigente:** P1-B se encerra quando a entrega revisada é integrada em `main` e o merge/SHA são confirmados por leitura de volta, após os gates de U5. A decisão de Aj separa o teste nativo de Claude em U6: ele acontece depois da entrega em `main`, não bloqueia o fechamento de P1-B e pode gerar um ajuste focal se aparecer um defeito concreto. U6 permanece pendente e não deve ser apresentada como executada.

**Estado atual:** U3 concluída no escopo funcional aceito, com U3.18 em 3/3 FULLs A/B/C PASS; a medição segue `incomplete`, não qualificada e adiada. U4.1 e U4.2 concluídas offline; U4.3 concluída no recorte focal Codex, incluindo readback terminal Q20 `COMPLETE`. Essas provas não demonstram uso real Claude, qualificação universal ou medição de H2.

| Unidade | Estado | Saída / limite |
| --- | --- | --- |
| U1 — Preparação conjunta | Entregue, com PASS histórico no recorte | Sem recertificação global automática. |
| U2 — Continuidade e recuperação | Entregue, com PASS histórico no recorte | Evidências posteriores complementam, sem apagar limites históricos. |
| U3 — Qualificação e QA | Concluída no escopo funcional aceito | Medição incompleta permanece adiada; não iniciar nova campanha por inferência. |
| U4 — Equalização Claude | Concluída nos recortes U4.1–U4.3 | Igualdade offline e prova focal Codex não equivalem a teste nativo Claude. |
| U5 — Entrega revisada | U5.0 autorizado; helper/teste legado sem consumidores removidos, smoke atual passou e revisão independente do diff não encontrou finding impeditivo; freeze pendente da identificação final do candidato | Depois: freeze local quando a árvore puder ser fixada; U5.1 push/PR draft com autorização própria; U5.2 CI e findings; U5.3 merge com aprovação expressa e readback. |
| U6 — Teste Claude por Aj | Pendente, pós-entrega | Acompanhamento separado; registrar observações e propor ajuste focal se necessário. Não é gate para fechar P1-B. |

### Limites e referências

- U3.18: [aceite funcional e medição adiada](maintenance/P1-B-PLANO.md#u318). Não alegar economia ou comparabilidade de métricas.
- U4.3: [disposição e alcance da prova focal](maintenance/P1-B-PLANO.md#u43-disposicao-de-impacto-e-requalificacao). Sem nova campanha, chamada de modelo, benchmark, push, PR ou merge nesta revisão local.
- U5: [sequência, critérios, autorizações e paradas](maintenance/P1-B-PLANO.md#u5). O estado congelado, CI e resultado de merge só podem ser preenchidos com evidência observada.
- U6: [teste Claude por Aj](maintenance/P1-B-PLANO.md#u6). Sem instalação nem uso Claude antecipados.

O plano detalhado é a fonte canônica dos históricos técnicos e decisões anteriores. Resumos superados ou contraditórios que antes estavam repetidos neste índice foram removidos; nenhum critério, ID de requisito P1B-01–09, decisão vigente ou resultado aceito foi alterado por essa limpeza.

O registro da correção local `af2aeb5` para `stnl-task-materializer` saiu do backlog ativo: esse workflow foi retirado do catálogo atual, a branch indicada no registro não existe neste checkout e o caminho do runtime não está no produto. Não há ação pendente de publicação associada a esse item.
