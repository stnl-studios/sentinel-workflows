# Validação da bancada App Server

**A bancada ainda não está integralmente qualificada.** O comando padrão único executou as três tarefas com duas repetições, mas o perfil misto terminou com 2 PASS e 4 BLOCKED. As execuções anteriores de referência chegaram a PASS/CLOSE nas três tarefas, em campanhas separadas. Nenhum desses resultados é certificado oficial, ranking de modelos ou estimativa de cobrança.

## Campanha padrão única: `mixed-full-01`

Comando real: `npm run benchmark -- --id mixed-full-01`, engine do commit `f0cb309`, sem override de perfil, tarefas ou repetições. O perfil padrão misto permaneceu intacto. Todas as seis células foram executadas serialmente; a desconexão do Mac não reiniciou nem duplicou a campanha.

| Célula | Resultado | Causa / evidência | Tokens observados |
|---|---|---|---:|
| rename-1 | BLOCKED | Revisão independente rejeitou carriers draft/pending; nenhuma ativação | 2.011.352 |
| query-1 | BLOCKED | Notação CLI `<caminho>` rejeitada como placeholder em três seções; correções locais esgotaram limite | 1.440.276 |
| import-1 | BLOCKED | Verificador invocou helper inexistente, diferente do helper oficial reservado; nenhuma receita formal | 6.438.251 |
| rename-2 | BLOCKED | Coordenador despachou checks sem implementar; filho retornou status semântico inválido, corretamente recusado | 3.050.364 |
| query-2 | PASS / CLOSE / oracle PASS | Dez configurações MATCH; duas cadeias de contrato/comunicação MATCH | 8.601.039 |
| import-2 | PASS / CLOSE / oracle PASS | Duas slices sequenciais; 14 configurações MATCH; quatro cadeias de contrato/comunicação MATCH | 11.286.136 |

Total observado: **32.827.418**, com 29.878.016 de cache, 2.635.664 de input novo e 313.738 de output. As seis células permanecem no denominador, incluindo falhas. Há lacuna explícita para uso não gravado/em voo; não são totais faturáveis. Import-2 levou 37m36s, próximo do limite de 40min; nenhuma célula teve orçamento reiniciado.

Os dois PASS foram auditados independentemente e possuem `harnessValid:true`. Os quatro BLOCKED não são convertidos em falhas legítimas de produto, nem demonstram por si defeito Sentinel: incluem autoria inadequada e uso incorreto dos controles pelos modelos. A campanha prova execução única e observação do perfil misto, **não sua robustez nem aprovação integral**. O perfil de referência não foi promovido silenciosamente a padrão.

Próximos gates: corrigir falhas gerais de orquestração comprovadas sem substituir decisões dos modelos, testar as correções prospectivas e demonstrar o fluxo completo escolhido. Não haverá promoção automática dos diagnósticos a resultados oficiais. Falhas de modelo continuarão visíveis, mesmo quando o harness estiver correto.

## Execuções reais de referência

Perfil explícito `reference-sol-high.json`: GPT-6.1 Sol/high em todos os papéis, mesma revisão Sentinel `2cdc33d39b801bc3e90ba09175e6a262977d3d62`, fixture inicial comum, uma repetição por tarefa e cópias independentes.

| Tarefa | Campanha | Resultado | Duração | Tokens observados | Cache, incluído no input |
|---|---|---|---:|---:|---:|
| Rename | `reference-rename-01` | PASS / CLOSE / oracle PASS | 26m45s | 7.756.288 | 7.059.072 |
| Query | `reference-query-import-01` | PASS / CLOSE / oracle PASS | 26m01s | 7.351.935 | 6.674.816 |
| Import transversal | `reference-query-import-01` | PASS / CLOSE / oracle PASS | 39m24s | 11.529.796 | 10.278.656 |

Total descritivo: 26.638.019 tokens reportados, incluindo 24.012.544 de cache, 2.406.015 de input novo e 219.460 de output. Cache não deve ser somado novamente; reasoning é subconjunto de output. Campos completos entre respostas observadas não excluem consumo não gravado/em voo nem equivalem a faturamento.

O transversal realizou duas slices com validação formal sequencial e reutilização da prova histórica antes de CLOSE. As slices alteraram conjuntos distintos de arquivos; não foi observada alteração de arquivo compartilhado, portanto não reivindicamos essa cobertura adicional. A execução ficou próxima dos limites de 40 minutos e 12 milhões de tokens observados por tarefa; uma amostra não estabelece latência ou consumo garantidos.

## Evidência e versões de análise

- Rename: 155 respostas únicas, dez configurações MATCH, aceitação 4/4 e regressão congelada 8/8. Duas cadeias literais filho → envelope → capture conferidas.
- Query: 146 respostas únicas, dez configurações MATCH; aceitação/regressão PASS e duas cadeias literais conferidas.
- Import: 219 respostas únicas, 14 configurações MATCH; aceitação/regressão PASS, quatro cadeias literais e trajetória de duas slices conferidas.
- Duas desconexões do host não causaram duplicação de execução. Os processos originais sobreviveram; a tentativa de retomada da referência rename foi recusada pelo lock ativo antes de executar qualquer turno.

Os registros originais são imutáveis. Rename executou antes da correção do coletor de envelopes no TMPDIR; sua auditoria derivada prova 2/2 cadeias sem trocar a identidade de execução pela do analisador. Import conserva a admissão original `harnessValid:false`: o coletor antigo não reconheceu a leitura integral do último contrato via cópia privada, hash e cat. A reanálise separada com o coletor corrigido prova 4/4 contratos MATCH. O conteúdo integral, a cópia confinada, os hashes e o comando limitado foram verificados, sem inferir leitura de fragmentos ou apenas do nome do modelo.

Correções dos observadores foram testadas prospectivamente e contra essas evidências, sem reescrever resultados nem repetir rodadas só para obter verde. Isso não transforma as execuções antigas em execuções da identidade posterior do engine. Nenhum resultado foi promovido automaticamente a oficial.

## Testes e limites

- Suíte completa offline da bancada: **368/368 PASS**, sem skips.
- Launcher: **13/13 PASS**; perfil, execução, status e relatório exercitados.
- A suíte geral do repositório teve falhas preservadas. Sete arquivos mantêm casos non-Git incompatíveis com temporários fisicamente sob este checkout; reproduzidos na main, não são um gate específico novo da bancada. O teste de sockets passou 175/175 com caminho relativo curto interno. Não declarar a suíte geral integral verde.
- O perfil misto permanece disponível, mas suas falhas de operação dos modelos foram preservadas. O sucesso do perfil de referência não demonstra robustez dessas combinações.
- Recuperação não promete exactly-once para efeitos arbitrários. Recibos completos permitem consulta ao mesmo owner pelo protocolo oficial; estados incertos e prazos esgotados continuam bloqueados.

## Uso e arquivos

```sh
npm run benchmark:profile -- --profile benchmarks/sentinel/bench/profiles/reference-sol-high.json
npm run benchmark -- --profile benchmarks/sentinel/bench/profiles/reference-sol-high.json
```

O segundo comando inicia chamadas reais e usa duas repetições por tarefa por padrão. Para uma rodada diagnóstica menor, use `--cases rename --repetitions 1`. Após a campanha e o diagnóstico prospectivo, o padrão foi alterado explicitamente para referência Sol/high por decisão técnica autorizada. O misto permanece selecionável; o novo perfil não é comparável como se fosse a mesma configuração nem herda qualificação. A campanha completa deste novo padrão ainda precisa ser verificada.

Logs, checkpoints, relatórios e auditorias derivadas ficam em `benchmark-temp/benchmark-v2/evidence/`, ignorados pelo Git. Resultados antigos estão separados em `benchmarks/legacy/sentinel-todo`. Não houve integração na main, push, instalação global ou uso do Claude corporativo.

Limpeza conservadora: os metadados `.git` dos três workspaces de referência concluídos foram arquivados com inventário, hashes, modos e extração verificada antes da remoção. Produtos e evidências continuam preservados. Para reproduzir comandos dependentes de Git nesses workspaces históricos, restaure primeiro os destinos descritos em `benchmark-temp/benchmark-v2/evidence/cleanup/pass-workspace-git-archive-v1/manifest.json`; não inicialize outro repositório sobre eles. Campanhas bloqueadas/incertas não foram limpas.

## Campanha de referência completa: resultado preservado

`reference-full-01` executou o novo padrão explícito em uma campanha: **4 PASS e 2 BLOCKED**. Rename e query passaram nas duas repetições. Os dois imports atingiram o limite operacional de 12M tokens reportados durante a última validação; não houve CLOSE. Os registros incluem PASS dos filhos, captura e publicação da validação, mas isso não autoriza transformar as células interrompidas em PASS final.

Total: 56.019.593 tokens observados, incluindo 51.246.720 de cache, 4.333.375 de input novo e 439.498 de saída. Os imports tiveram 12.084.329/12.065.302 tokens, dos quais 11.080.192/11.057.280 eram cache. Esse limite controla volume bruto observado, **não custo faturável**. A observação atrasada permite pequeno excesso; lacunas de consumo continuam explícitas.

A auditoria não encontrou loop de slices nem soma indevida de snapshots. Houve saídas volumosas e algumas releituras de bundles, também presentes em PASS anteriores; não existe correção causal única demonstrada. Rename-1 levou 39m16s, deixando somente 44s da janela de 40min. Tempo e tokens são restrições independentes.

Contraprova limitada aprovada: `diagnostic-import-margin.json`, somente import, uma repetição, 14M tokens observados, mantendo 40min, 20 turnos e proteção contra falta de progresso. Justificativa: consumo observado próximo de 12,1M, CLOSE histórico de aproximadamente 267k e margem limitada para variação/atraso. O perfil padrão e a campanha anterior não são alterados; a contraprova não qualifica retrospectivamente a campanha. Não haverá série automática de aumentos caso o tempo se esgote.

## Contraprova import: observação e decisão pendente

`import-margin-01` concluiu PASS/CLOSE/oracle e trajetória em 37m00,160s, nove turnos, com harness válido. As 14 configurações, quatro contratos e quatro cadeias de comunicação foram conferidos independentemente. Consumo observado: 11.475.654 tokens (10.385.408 cache, 997.596 input novo, 92.650 saída), com lacunas de uso preservadas.

O total ficou **524.346 abaixo do antigo teto de 12M**. Portanto, este sucesso não demonstra que elevar o teto para 14M causou melhora. Ele confirma outra execução completa, sob configuração explicitamente distinta, mas não transforma o resultado 4/6 da campanha padrão em 6/6.

Os dois imports bloqueados da campanha anterior não são retomáveis como se ainda tivessem orçamento: coordenadores foram interrompidos, prazos expiraram e o teto foi consumido. Aproveitar o PASS dos filhos não equivale a completar CLOSE e oracle sob a mesma tentativa. Os checkpoints e resultados originais permanecem intactos.

Proposta operacional, ainda não aplicada aos padrões: permitir somente limites de célula por tarefa e fixar import em 14M tokens observados; manter rename/query em 12M, 40min por célula, 60M por campanha, 20 turnos e limite de falta de progresso. Trata-se de calibração de margem, não correção de teste nem preço calculado. Os volumes de cache/input novo/output continuam separados e o bruto permanece visível. A margem de tempo é independente e segue apertada; não aumentar automaticamente se houver timeout.

Para qualificação reproduzível, a configuração escolhida precisará ser congelada e executar as seis células em uma campanha nova, com os mesmos gates de produto, formalização, CLOSE, oracle, configuração e integridade de evidência. Essa matriz não foi iniciada. Até lá, o estado correto é **bancada diagnóstica utilizável, qualificação integral pendente**.

## Calibração prospectiva autorizada

Após consolidar os resultados, foi autorizada a configuração `reference-gpt-61-sol-high-v2`: import 14M tokens observados, rename/query 12M, mantendo 40min por célula, 60M/4h por campanha, modelos, esforço e todos os critérios. A superfície existente `caseOverrides` recebe somente `limits.maxReportedTokens`; não permite alterar os demais limites por tarefa. A prioridade é do valor explicitamente definido na tarefa, com fallback ao global.

O próximo passo autorizado é **uma campanha de aceitação com o comando padrão**, não modo official, certificado ou publicação. Nenhum resultado anterior é reclassificado e não haverá novas tentativas ou aumentos automáticos se essa campanha falhar.
