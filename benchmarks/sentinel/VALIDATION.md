# Validação da bancada App Server

**A bancada ainda não está integralmente qualificada.** A aceitação mais recente (`acceptance-watchdog-v3-01`, engine do commit `5f32df0`) executou as três tarefas duas vezes pelo comando padrão: **5 PASS e 1 BLOCKED por tokens**. O transversal aprovado precisou de44m42, além dos40min diagnósticos e dentro do watchdog50min. O padrão é referência Sol/high; o misto anterior permanece disponível e não qualificado. Resultados experimentais, sem certificado oficial, ranking ou estimativa de cobrança.

## Aceitação watchdog v3: resultado preservado

Único comando: `npm run benchmark -- --id acceptance-watchdog-v3-01`, referência Sol/high v3. Todas as seis células foram executadas sem reinício ou alteração em andamento.

| Célula | Resultado | Duração | Tokens observados |
|---|---|---:|---:|
| rename-1 | PASS / CLOSE / oracle | 24m33s | 7.287.037 |
| query-1 | PASS / CLOSE / oracle | 32m47s | 9.475.879 |
| import-1 | BLOCKED / OBSERVED_TOKEN_LIMIT | 47m20s | 14.103.631 |
| rename-2 | PASS / CLOSE / oracle | 26m43s | 6.943.156 |
| query-2 | PASS / CLOSE / oracle | 27m22s | 8.244.266 |
| import-2 | PASS / CLOSE / oracle | 44m42s | 13.758.919 |

Duração total3h23m31,768s;59.812.888 tokens observados, incluindo54.679.424 cacheados,4.645.837 input novo e487.627 saída. O teto global60M teve apenas187.112 tokens de margem; não foi elevado. A observação atrasada permitiu103.631 acima do teto14M da primeira importação antes do corte. Não é teto financeiro rígido nem total faturável; uso em voo/não descarregado continua desconhecido.

Ambas importações ultrapassaram a referência diagnóstica40min. Import2 demonstra percurso legítimo concluído em44m42 sob o watchdog50min; import1 continuou bloqueado por volume antes de50min. Não há6/6 nem união com PASS de outras campanhas. Nenhuma nova execução ou recalibração foi iniciada após esta campanha.

### Causa observada e limites de atribuição

Import1 teve uma correção legítima de teste na EXECUTE2:115/116 passou, pois um teste novo esperava um espaço interno quando os argumentos de `add` produziam dois, preservados pelo comportamento existente. O controlador admitiu correção; ajustada a expectativa, um novo check independente passou116/116. A falha anterior está preservada. EXECUTE2 levou12m45, revisão8m41 e PLAN/correção8m09; chegou à validação final após~43m42 em turnos concluídos. Isso não foi revalidação de slice antiga. Saída agregada~3,79M caracteres, contra~3,93M na v2, sem explosão uniforme de dumps. Não foi identificado defeito Sentinel concreto com correção pequena demonstrada; não se exclui custo documental do fluxo.

A auditoria da v2 anterior confirmou fonte2cdc33d e contrato instalado byte-exato, com PASS histórico preservado. Houve EXECUTE1→VALIDATE1→EXECUTE2→VALIDATE2, sem replay formal1. Somente9,476s(0,39%) do tempo decorreram fora dos turnos principais;11 esperas pelos filhos somaram8m18. O restante mistura processamento de contexto/inferência/rede e não permite atribuição causal completa. Comandos rápidos com saídas volumosas não provam baixo custo de processamento posterior.

Próximo passo não é aumentar limites em série: consolidar a decisão de aceitação da bancada separadamente dos resultados censurados, ou investigar uma hipótese específica de eficiência do Sentinel com prova offline antes de nova campanha. O requisito previamente usado de seis percursos completos não foi satisfeito. Mantidos os controles e os dados para essa decisão, sem promoção automática. Testes determinísticos anteriores ao run:377/377 e launcher13/13 PASS.

Evidências: `benchmark-temp/benchmark-v2/evidence/campaigns/acceptance-watchdog-v3-01/`. A main e instalação global permaneceram intocadas; nenhum push/site/Claude. Auditoria independente confirmou hashes/configurações/provas de todos os PASS; import2 tem14 configurações e4 cadeias contrato/comunicação MATCH. Apenas5 diretórios `.git` dos PASS foram arquivados, extraídos e comparados antes de remoção(820KiB), com ausência de processos/locks. Recibo: `benchmark-temp/benchmark-v2/evidence/cleanup/acceptance-watchdog-v3-01-pass-git/audit.json`. BLOCKED, produtos, controles e evidências preservados.

## Aceitação anterior: seis células, sem promoção

Comando único real: `npm run benchmark -- --id acceptance-reference-v2-01`. Perfil `reference-gpt-61-sol-high-v2`, GPT-6.1 Sol/high em todos os papéis; import com 14M tokens observados, rename/query com 12M. Mantidos 40min por célula, 4h/60M por campanha, modelos, critérios e demais limites. Engine `7cad5f41bb653add8dac0fb5d25981736907f2ccc90883f7c349f5329ec085c3`.

| Célula | Resultado | Duração | Tokens observados |
|---|---|---:|---:|
| rename-1 | PASS / CLOSE / oracle | 27m51s | 8.769.742 |
| query-1 | PASS / CLOSE / oracle | 27m27s | 7.432.879 |
| import-1 | BLOCKED / CASE_DEADLINE | 40m00s | 11.744.470 |
| rename-2 | PASS / CLOSE / oracle | 27m42s | 7.652.428 |
| query-2 | PASS / CLOSE / oracle | 28m16s | 7.771.935 |
| import-2 | PASS / CLOSE / oracle | 37m11s | 12.028.066 |

As seis células foram executadas serialmente na mesma campanha, em 3h08m30,809s. Total **55.399.520** observado: input 54.943.735, incluindo cache 50.857.088; input novo 4.086.647 e saída 455.785. A soma não duplica cache nem reasoning. Campos completos das respostas observadas não excluem uso não descarregado/em voo e não demonstram cobrança. `harnessValid:true` nas seis células valida a admissão da medição, não transforma a tarefa bloqueada em PASS.

### Diagnóstico e decisão pendente

Import-1 alcançou a validação formal da segunda slice, mas não CLOSE. Suas duas execuções passaram na primeira rodada; não houve loop de findings/reexecução. O tempo acumulado dos turnos anteriores à última validação foi ~35m36, contra ~30m12 na contraprova `import-margin-01` (PASS em 37m00). A diferença concentrou-se na revisão (+1m55) e na segunda execução (+2m35), além de variações menores e uma correção legítima de placeholders no plano. Leituras duplicadas e erros exploratórios foram observados, mas não há causa única cuja correção comprovadamente faça o percurso caber em 40min.

Import-2 passou em 37m11, com 12.028.066 tokens: a calibração prospectiva de 14M ofereceu margem de tokens, mas não corrigiu variabilidade de tempo. A contraprova PASS usou somente 11.475.654 tokens, abaixo do antigo teto. Esses fatos não autorizam unir campanhas ou excluir o import-1 do denominador. A campanha atual permanece **5/6, não 6/6**.

Próximo passo recomendado: decidir explicitamente se 40min é um requisito de latência do produto ou um watchdog operacional. Se for requisito, conservar esta reprovação e investigar redução demonstrável de latência sem remover etapas legítimas. Se for watchdog, uma futura calibração prospectiva por tarefa pode ser avaliada com os tempos observados e custo de espera, sem promessa de sucesso nem aumentos em série. Não foi implementado novo teto de tempo nem iniciada outra rodada. Reduzir o cenário ou trocar modelos também mudaria a identidade de comparação e não é correção retroativa.

Fluxo futuro preservado: validar a feature localmente; integrar somente com autorização explícita; depois executar benchmark oficial no commit exato da main e preparar PR separada somente com resultados curados para histórico/site. Esta aceitação e a contraprova continuam experimentais. Nenhuma integração, publicação, instalação global ou execução Claude foi feita.

Evidências originais: `benchmark-temp/benchmark-v2/evidence/campaigns/acceptance-reference-v2-01/`. Falha e checkpoint da primeira importação permanecem intactos. A campanha não foi retomada com prazo renovado. Auditoria independente confirmou 10 configurações e duas cadeias de contrato/comunicação em cada rename/query PASS; import-2 confirmou 14 configurações e quatro cadeias completas. Import-1 conserva três comunicações completas, não quatro. Somente os cinco diretórios `.git` dos PASS foram arquivados, extraídos e comparados antes da remoção (820KiB), após confirmar ausência de processos/lock. Recibo e restauração: `benchmark-temp/benchmark-v2/evidence/cleanup/acceptance-reference-v2-01-pass-git/audit.json`. Produtos e controles foram preservados.

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

## Próxima calibração prospectiva de watchdog (v3)

Os 40min são proteção operacional contra execução indefinida, não SLA nem critério funcional. A referência v3 mantém Sol/high, fixture, critérios, etapas, 14M import/12M demais e passa apenas import para50min. Rename/query permanecem40min; os limites globais4h/60M continuam prevalentes, ainda que a soma dos máximos individuais seja260min/76M. Assim, o orçamento global pode censurar uma campanha antes de cada célula consumir todo seu teto, por design.

Os40min permanecem referência diagnóstica no relato dos tempos, sem novo gate. Uma única campanha íntegra é autorizada após testes determinísticos e verificação de ausência de concorrência; se exceder orçamento, não haverá reinício nem aumento automático. Campanhas antigas permanecem intactas, e qualquer resultado novo pertence à nova identidade de perfil/engine.

## Intervenção documental Sentinel: navegação positiva de evidência

Após a v3, os contratos equivalentes Codex/Claude e os dois guides de runner passaram a explicitar os campos reais `reviewedArtifacts[].utf8`, `normativeProjection` e `objects: [{id, bytesBase64}]`. A orientação reutiliza `inspect` e `verify-native`, distingue estado/recibo de autoridade e seleciona metadados/IDs antes de abrir prova específica. Não há novo runtime, gate, sumarizador, truncamento ou substituição de snapshot/PlanTasks/contrato integral independente. Originais e provas obrigatórias permanecem acessíveis e intactos.

O exemplo documental executável é apenas navegação/apresentação, não validador oficial. Testes extraem o código dos dois guides, comparam paridade, executam fixture sanitizada congelada, verificam fidelidade e falhas explícitas por ausência/duplicatas/Base64/hash inválidos.8/8 PASS; apresentação sintética39.482→330 caracteres. Essa redução não mede consumo de modelo, não garante adesão da LLM/latência e não elimina leitura normativa obrigatória. Contrato runner47/47 e validação estrutural/paridade PASS. Nenhuma contraprova de modelo executada nesta intervenção.

Uma contraprova futura deve usar somente import×1, preservando Sol/high,50min/14M e globais4h/60M, mas apontando explicitamente para o commit candidato Sentinel. Reusar o pin antigo2cdc33d não testaria esta mudança. Resultado seria diagnóstico separado, nunca substituto do BLOCKED de campanhas anteriores.

## Contraprova documental e consulta runtime offline

`diagnostic-sentinel-reading-import-01` executou somente import×1 no candidato `b7ad4a9`, mesmo Sol/high e limitesv3. Terminou BLOCKED/OBSERVED_TOKEN_LIMIT em41m08,287s, durante VALIDATE slice02, sem CLOSE.14.159.738 tokens são a soma conferida de228 respostas únicas, não snapshots cumulativos:13.035.904 cache,1.017.455 input novo,106.379 saída. Resultado original SHA256 `11b8b083a98f6bea61d8438ea7cee8023ee92c74bf2c01bd0b9d20e6a3449427` preservado. Os novos contratos foram lidos, mas seleção parcial ainda expandiu `recordUtf8` aninhado; menos stdout não demonstrou menor consumo global. Nenhuma matriz se seguiu.

A intervenção seguinte é somente offline: `inspect-evidence` no controller existente, reutilizando captura autenticada e `validateCurrentEvidence`, sem armazenamento/validador paralelo. Quiet SPEC exige imagem quiet; origin ativo exige owner/A1/reservedActivation e restringe à própria entrega. Índice positivo não expande recordUtf8/Base64; seletores explícitos devolvem corpos exatos e hashes. Corrupção, ausência, ambiguidade, origin stale ou entrega estrangeira falham. Nenhuma nova autoridade ou veredicto é criado; snapshot normativo, independência e provas necessárias permanecem obrigatórios.

Testes:3/3 de consulta com fixtures reais,274/274 regressões native/quiet/boundaries,55/55 contrato/exemplos e validação estrutural PASS. Consultas não alteraram arquivos/controles. No fixture, índice2.316 versus bundle53.389 caracteres. No bundle real da entrega admitida, índice2.384 compacto/2.892 formatado versus136.311 de bundle e31.959 de registros formatados semobjects; um registro e seis objetos retornaram bytes/hash iguais. Esses números medem apresentação, não tokens/latência.

Os dumps213.850/139.829/101.254 misturam conteúdo normativo obrigatório e evidência de outra entrega. A consulta ativa recusou corretamente essa sibling; quiet recusou owner ativo. Portanto, não reivindicamos substituir todo esse volume nem demonstrar melhora do percurso completo. Nenhuma execução de modelos, alteração de perfil/limites, integração ou publicação ocorreu nesta intervenção offline.

## Contraprova de descoberta do índice e recuperação offline de draft

O candidato `b2f3893` acrescentou ao contrato canônico independente a referência geral a `inspect-evidence`, com paridade Codex/Claude, sem instrução especial da bancada. Contrato/exemplo/reader59/59 e estrutura PASS. `diagnostic-evidence-inspection-import-01` manteve harness `579c52a2184a8889dd482f9b6d8981973378ef67a24a6ffa067cd544c8f699a0`, fixture `0214744b5442a4df52f71b3392b2ab6531cd34fa25b93b5a4b58cb1504c731fe`, Sol/high e limitesv3, mas terminou BLOCKED em8m25,686s, no segundo turno, antes de EXECUTE/VALIDATE. Resultado SHA256 `bb01ed56743d781696d168f72ac052488050dd198a4a2917fce2b684ade7c9f7` preservado.746.696 tokens observados de21 respostas únicas:612.480 cache,111.810 input novo,22.406 output. Observações repetidas não foram contadas duas vezes. Nenhum uso real do índice ou ganho no percurso ficou demonstrado.

Causa: a primeira slice planejava um arquivo novo, mas a segunda o declarou Existing Input antes de existir. O preflight recusou com `EVIDENCE_STALE`; o adaptador preservou esse código e corretamente não o admitiu no ciclo restrito a `INVALID_CURRENT_IMAGE`. A falha original continua registrada como unclassified/harnessValid=false, sem reclassificação retrospectiva.

A correção subsequente é offline: os dois pontos precisos de input ausente/não arquivo passam a ter causa tipada; o leitor mantém `EVIDENCE_STALE`. Somente `capturePreparationDraft` em PLAN inicial sem captura, aprovação, instalação, publicação pendente ou execução ativa converte essa causa para `INVALID_CURRENT_IMAGE`/`DRAFT_EXISTING_INPUT_UNAVAILABLE`, rechecando os guards. O adaptador conserva reasonCode no envelope/ledger, sem ampliar o predicado de recuperação. A revisão continua pelo export oficial, mesma alocação, provider concluído/idle e duas correções no orçamento original. Evidência aprovada alterada, REPLAN e efeitos incertos não ganham recuperação por essa classificação. Não há nova execução de modelos nem alteração de pin/limites nesta correção.

Verificação offline da classificação:4/4 testes com runtime real, incluindo ponte real `capturePlan` → export oficial → `recoverUncapturedDraft` → `revisePreparationDraft` → nova captura, na mesma alocação e sem criar o produto futuro; captura posterior impede reutilizar a recuperação. Casos de input legítimo, ausência/não arquivo, NO_EXECUTION, aprovação e marcadores de instalação também cobertos.20/20 regressões de draft editável,30/30 testes de adaptador/recuperação simulada e379/379 testes da bancada PASS. Uma primeira cópia de teste sem fixture apresentou27 ENOENT; após incluir a fixture original, a suíte completa passou, preservando ambos os logs. Estrutura/paridade PASS. Isso prova a recuperação determinística, não adesão do modelo nem qualificação live.

## Contraprova final isolada após recuperação de draft

`diagnostic-draft-recovery-import-01`, pin `b04e02da755929b72ffa2a8b1f74401829ed75ef`, terminou **BLOCKED/OBSERVED_TOKEN_LIMIT** durante VALIDATE slice02, sem CLOSE/oracle, em38m06,905s e9turnos. O teto observado14M, watchdog50min e globais4h/60M foram preservados. Resultado SHA256 `b01b290188a478250dbb257db771bfa7d157b972ddcd176e02e57314756de71a`; summary `dc3f1745f737c2b1d719d599e9fbd7b9d98885a0f35d6d302cdf09f6c4ece0bf`. Sem nova rodada após isso.

225 respostas únicas somaram14.201.393 tokens: input14.108.292, incluindo cache13.216.640 (93,07% do total observado), input novo891.652 e saída93.101. Contadores cumulativos/observações duplicadas não são somados novamente. Isso não é custo faturável; uso não descarregado ainda pode faltar. Por etapa (inclui filhos, cujos tempos se sobrepõem aos principais): INIT378.982/cache346.112; PLAN913.855/cache847.488; APPROVE30.424/cache10.368; REVIEW1.744.197/cache1.627.136; EXECUTE5.322.657/cache4.953.728; VALIDATE5.811.278/cache5.431.808. CLOSE não executado.

Houve uma correção natural de PLAN por `serial requirements: invalid requirement IDs`, na classe já suportada, com mesma alocação. A causa nova `DRAFT_EXISTING_INPUT_UNAVAILABLE` não ocorreu no live e continua sustentada pelos testes offline. Consulta compacta foi usada espontaneamente: três índices (principal quiet e dois filhos com origin), um record e um object, todos exit0. Índices exibidos2.385/2.387 caracteres; outros retornos foram salvos em temporários para leitura seletiva. Cinco comandos reportaram80/107/82/59/264ms, total592ms; não inclui inferência/descoberta e não permite atribuir tokens exatos à consulta. Referências ao comando dentro de gravações do contrato não foram contadas como chamadas.

229 arquivos de skills instalados conferem com manifest; guias/controllers conferem com pin; quatro contratos independentes MATCH. Fixture/oracle/CLI iguais ao diagnóstico anterior; engine `b17c618ec9d6af600b63a25354fb1fc8e528aa4cd8c348a2d1da02754ea477fd` difere só pela preservação de reasonCode em três arquivos e dois testes. A observação da bancada foi classificada harnessValid=true, não taskPassed. Comunicação tem3pares MATCH e3INCOMPLETE (referências não capturadas/final interrompido), sem inventar completude. Trajetória completa e alteração de arquivo compartilhado não foram demonstradas.

Cobertura separada: fixture serial permite a saída futura da primeira slice como produto/dependência da seguinte, sem pré-criar arquivo; a falsa Existing Input é corrigível somente antes de aprovação; reader/consulta continuam recusando evidência necessária ausente/corrupta sem escrever controles ou apagar prova histórica. A recuperação do PLAN não prova redução de overhead. O uso real da consulta não provou economia total nem fechamento dentro do teto. Comparar finais interrompidos com PASS de outras trajetórias não estima efeito causal.

Próximo diagnóstico discriminante seria offline: inventariar nos traces as leituras integrais obrigatórias versus reexpansões idênticas dispensáveis por papel/fase, mantendo identidade e provas. Contar bytes exibidos é apenas um limite de apresentação, não simulação de tokens poupados. Não há, nesta auditoria, hipótese curta comprovada que justifique outra mudança ou novo aumento de teto. Nenhuma implementação ou campanha adicional está autorizada por este relatório.

## Ambiguidade da bancada corrigida offline após pausa

O guard do prompt dizia preservar “saídas originais em arquivo”, inclusive no parágrafo de disciplina de leitura. Isso podia incentivar retranscrição de fontes locais já disponíveis em literais/heredocs/configurações, trabalho distinto dos recibos obrigatórios. O trace da última contraprova confirma que o próprio filho já leu diretamente o contrato e os artefatos locais (eventos5725/5753/5758); reconstruir esses textos pelo principal não substitui nem agrega prova independente.

A alteração é somente no prompt da bancada: passar caminhos canônicos/hashes em vez de retranscrever bytes existentes; preferir leitura integral direta pelo filho; se cópia for necessária, usar a cópia direta/hash/leitura integral já reconhecida. Reutilizar leitura idêntica no mesmo contexto sem mudança, mantendo releitura em contexto novo/alteração/truncamento/incerteza. A orientação não modifica recibos, captura literal da resposta final, autoridade, parser de prova, modelo, limites ou fluxo. Não há helper novo.30/30 testes offline de prompt/contrato PASS, incluindo contraprovas de corpo truncado, thread errada, fonte alterada, cópia insegura, origem não comprovada e tee arbitrário. `git diff --check` PASS. Isso elimina uma ambiguidade concreta, mas não mede economia de tokens ou garante CLOSE; nenhum modelo executado após a mudança.
