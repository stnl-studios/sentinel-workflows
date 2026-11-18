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
