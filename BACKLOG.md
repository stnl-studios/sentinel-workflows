# Backlog de decisão do Sentinel Workflows

Este arquivo consolida a decisão pós-P0 v2.1 e é a referência canônica para prioridades futuras. A aceitação de P0 permanece registrada em [`maintenance/p0-summary.md`](maintenance/p0-summary.md). O checkpoint integrado pós-P0 na `main` foi `e114555f94ceeeb76c83ecf7337fa3b19d621feb` (PR #1).

Ler o backlog não inicia um item, não cria issue e não aprova automaticamente uma execução. Trabalhar em uma entrega por vez; a conclusão de uma não inicia a próxima.

## Prioridades

| ID | Prioridade / estado | Escopo |
| --- | --- | --- |
| BL-01 | P0 concluída — atendido | Manutenção pragmática; não reabrir automaticamente. |
| BL-02 | P0 concluída — atendido | Clareza e eficiência do workflow; evolução de tasks não desfaz esse aceite. |
| BL-03 | P1-A — implementação do recorte concluída; integração via PR pendente | Installer global de skills de workflow e agents nativos Codex/Claude, mais README de onboarding. A certificação nativa nos dois clientes não foi concluída. |
| BL-08 (ID documental proposto) | P1-B — proposta independente | Melhorar tasks operacionais, materialização e review, sem migrar schema ou história. Não é issue criada nem trabalho iniciado. |
| BL-04 | Adiado / sob demanda | Roadmap, principalmente melhoria de layout; objetivo original preservado. |
| BL-05 | Adiado / sob demanda | Refinar user stories e produzir tasks para boards; diferente das tasks internas de execução. |
| Sem ID novo | Runbook sob demanda | Melhorar apenas quando selecionado; validação formal do workflow continua obrigatória. |
| BL-06 | Futuro | Orquestração geral. O manager de benchmark não comprova esse epic. |
| BL-07 | Última etapa | Sentinel Platform; não antecipar sua infraestrutura. |

P1-A e P1-B têm foco sequencial, mas não há dependência técnica obrigatória entre eles. Roadmap, runbook e refinamento de user stories continuam adiados ou sob demanda.

## P1-A — Installer global e README

O recorte solicitado de implementação do installer e do README está concluído neste branch; a integração na `main` depende da revisão da PR. Isso não representa `PASS` do aceite original completo: a prova contratual de descoberta, invocação e runner nativos em Codex e Claude continua sem certificação. A limitação observada na captura/serialização dessa evidência fica para discussão em P1-B; não foi corrigida nem validada neste recorte.

**Resultado esperado:** uma pessoa entende o propósito, instala com segurança e percorre o fluxo documentado.

O comando padrão, executado na raiz do checkout local, é `npm run sentinel:install`. Ele instala ambas as plataformas: skills de workflow e seus recursos internos necessários, mais os agents nativos em `~/.codex/skills`, `~/.codex/agents`, `~/.claude/skills` e `~/.claude/agents`. `npm run sentinel:install -- --preview` lista criações, substituições e remoções sem escrever; `--target codex` ou `--target claude` limita a plataforma.

Decisão aprovada mais recente: a instalação normal é uma reinstalação limpa do conteúdo Sentinel selecionado. Skills registradas são substituídas como componentes inteiros se divergirem da fonte, removendo arquivos extras; agents Sentinel divergentes são substituídos. Componentes idênticos permanecem `NO-OP`. Skills obsoletas com prefixo canônico `stnl-` e agents obsoletos que correspondem aos padrões nativos da plataforma são removidos. O inventário completo, incluindo leitura das fontes, acontece antes de qualquer remoção ou escrita. Entradas ambíguas no namespace gerenciado bloqueiam o planejamento sem alterações.

A fronteira de exclusão se limita a pastas imediatas de skills e agents em `~/.codex` e `~/.claude`; skills de domínio fora do pacote de workflow e agents fora dos padrões nativos Sentinel permanecem preservados. Não alterar projetos consumidores nem instalar dependências automaticamente. Falhas durante aplicação reportam os caminhos aplicados/incompletos, sem mecanismo de transação ou rollback.

Distribuir somente o workflow e agents nativos. Benchmark, manager, seeds, medições, baselines, cache, `node_modules`, SDK e runtimes de benchmark ficam fora da instalação. Não reescrever trechos de skills durante a cópia: a distribuição mantém o conteúdo canônico integral e exclui apenas arquivos de benchmark ou desenvolvimento que não são recursos da skill.

O README deve cobrir propósito e limites, pré-requisitos, prévia e aplicação, destinos globais, primeiro uso, fluxo, runner e mapa do repositório. A cadeia operacional preservada é:

`Autoridade pronta → stnl-execution-planner / PLAN → stnl-plan-reviewer / REVIEW_PLAN → stnl-task-materializer / MATERIALIZE_TASKS → stnl-task-reviewer / REVIEW_TASKS (normal em pristine) → stnl-slice-executor / EXECUTE_SLICE → stnl-slice-quality-manager / VALIDATE_SLICE`.

O aceite exige composição necessária, destino global preservado fora do namespace Sentinel, reinstalação limpa, repetição idêntica sem mudança de bytes, prévia sem escrita e demonstração de descoberta, invocação e runner no Codex e no Claude. A documentação deve refletir essa prova e seus limites. Cliente indisponível fica `NOT_VERIFIED`; prova em um cliente só não sustenta `PASS` completo, e um recorte parcial exige decisão explícita. O diff fica limitado ao installer, READMEs, testes focados e dependências internas comprovadamente indispensáveis.

Fora do escopo: package manager genérico, publicação npm, auto-update, uninstall genérico, cloud, redesign de lifecycle, infraestrutura de plataforma e conteúdo de benchmark. A prova atual do installer e testes isolados não substituem a demonstração nos dois clientes.

## P1-B — Tasks operacionais

**Resultado esperado:** ações úteis e verificáveis com menos narrativa repetida, preservando a cadeia e os contratos existentes.

Possível escopo: instruções e templates do materializer, orientação do task reviewer e ajuste pontual da entrada do plano somente quando necessário. As ações devem apontar resultado observável, áreas autorizadas, requisito de referência e verificação resolvível. A avaliação usa uma slice nova em estado pristine.

Preservar requisitos, estratégia aprovada, cabeçalhos, sentinelas, fingerprints, revisões, índice global, claims de paths, histórico, publishers, validação e handoffs. Não migrar artefatos antigos nem introduzir novo estado de aprovação. O serializer exige cardinalidade entre paths e claims de `Likely Areas`; não duplicar paths concretos para melhorar aparência. O materializer lê o plano global e todos os planos aprovados; não prometer materialização de uma slice isolada sem mudar seu contrato.

O aceite exige ações ligadas ao aceite, sem novos requisitos, referências de teste localizáveis e consumidores válidos; uma slice real mantém review, execução e validação independente. Não inventar cotas de linhas, tasks ou slices nem percentuais de tokens.

## Workflow e decisões a preservar

As skills retornam e param; handoffs vêm do estado oficial. No benchmark gerenciado, o manager existente consome o handoff e despacha a próxima operação. O runner é delegado dentro de `EXECUTE_SLICE`, `APPLY_FINDINGS` e `VALIDATE_SLICE`; checks auxiliares não são `PASS` formal.

`NEEDS_FIX → APPLY_FINDINGS → checks → nova VALIDATE_SLICE`. `PASS` intermediário leva à próxima slice autorizada; último `PASS` íntegro conclui a execução. Em `COMPLETE` saudável, o runtime não oferece próxima operação normal; a integração gerenciada conecta ao lifecycle `MODE=CLOSE`. Não existe `stnl-execution-closer` no registry. Um requisito standalone não exige inventar uma SPEC.

Mudança de requisito ou estratégia segue `RESUME` documental, se necessário, depois `REPLAN` explícito, `REVIEW_PLAN`, materialização de recovery e a fronteira persistida. Não sobrescrever histórico; review pristine não se aplica ao histórico operacional.

## Redesign, evidência e encerramento

Redesign futuro exige um problema, responsável e exemplo real, comparando ajuste local, mudança estrutural e a opção de não mudar. Selecionar um resultado demonstrável; redesign não é extensão automática de P1 nem pré-requisito de conclusão.

O renderer de runbook tem um achado conhecido: inclui cenários ignorados na agregação de aprovação. Não usar o resultado visual como aceite formal. Manter o responsável ciente; corrigir pontualmente somente por demanda concreta, sem incluir isso automaticamente em P1.

Preparação, documentação e testes são trabalho interno, não slices cerimoniais. A validação é proporcional ao aceite e aos consumidores afetados. Em P1-A, executar testes focados do installer e regressões diretamente relacionadas; benchmarks ficam fora desta prioridade. Se surgir mudança arquitetural material, parar antes de implementá-la e apresentar requisito, abordagem simples, insuficiência e acréscimo mínimo para decisão.

Depois de duas rodadas sem ganho objetivo, parar e decidir com o checkpoint preservado; rollback não é automático. Ao satisfazer o aceite, registrar resultado, diff, evidências, limitações e próximo passo informativo, e parar. Não iniciar outra prioridade, hardening, commit ou push automaticamente.

G3 comprova observabilidade suficiente para avaliar pressão de contexto; não comprova redução de tokens ou economia. Seu aceite P0 e evidências permanecem em [`maintenance/p0-summary.md`](maintenance/p0-summary.md) e não devem ser reabertos automaticamente.
