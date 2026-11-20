# Sentinel benchmark

Nova bancada App Server: três tarefas independentes (`rename`, `query`, `import`), cada uma iniciada de uma cópia limpa do mesmo projeto Todo. A tarefa transversal contém suas próprias slices sequenciais. Nenhuma tarefa depende do resultado de outra.

Veja [validação funcional das três tarefas e limites](VALIDATION.md).

## Um comando

```sh
npm run benchmark
```

Gera um ID único, executa duas repetições por tarefa e entrega relatório, resultados, configurações efetivas e evidências. O modo padrão é **diagnóstico**, com o perfil `bench/profiles/reference-v5-observe.json`: tokens são somente telemetria; turno de 30 min na importação e 15 min nas demais tarefas; prazo de 50 min na importação, 40 min nas demais e 4h no total. Continua GPT-6.1 Sol/high, exceto o coordenador de EXECUTE_SLICE na importação em medium; Sentinel fixado em43659631. Essa configuração não foi qualificada. O perfil v4 com limites de tokens permanece byte a byte em `bench/profiles/reference-sol-high.json` e deve ser escolhido expressamente via `--profile`; v3 e o perfil misto também seguem disponíveis.

**O comando inicia chamadas reais de modelos.** Antes de executar, ajuste CLI/versão, revisão Sentinel, modelos e limites no perfil. A revisão deve ser um commit local completo. Modelos/esforços indisponíveis ou configuração divergente não recebem fallback silencioso. Somente GPT está configurado; não usa Claude corporativo.

```sh
npm run benchmark:profile
npm run benchmark:test
npm run benchmark -- --id meu-diagnostico --cases import --repetitions 1
npm run benchmark -- --profile benchmarks/sentinel/bench/profiles/meu-perfil.json
npm run benchmark:status -- --id meu-diagnostico
npm run benchmark:report -- --id meu-diagnostico
```

`benchmark:test` é offline: não chama modelos nem instala globalmente. O launcher copia código e fixture verificados para `benchmark-temp/benchmark-v2`; **todas as rodadas, cópias, sessões, logs e temporários ficam ali**, ignorados pelo Git. Não execute `bench/cli.mjs` diretamente na árvore-fonte.

## Perfis por tarefa e etapa

`roles` contém modelo e esforço. `stageRoles` seleciona o coordenador por etapa. `caseOverrides.rename`, `.query` e `.import` substituem roles e/ou stageRoles daquela tarefa. `caseOverrides.<tarefa>.limits` aceita `maxReportedTokens` e/ou `caseMs`, sem alterar tentativas nem orçamento global. O padrão de referência v3 usa 14M/50min para import e 12M/40min para rename/query, mantendo 60M/4h por campanha. O global sempre prevalece: a soma dos máximos individuais (260min/76M) pode ser cortada pelos tetos globais, por design. Os 40min anteriores são referência diagnóstica de duração, não critério funcional; o relatório de aceitação informa quando ultrapassados, sem outro gate. Esse volume inclui cache e não representa custo faturável. Os atores independentes `plan_approver`, `plan_review`, `execute_check` e `formal_validate` têm sua própria configuração; mudar o coordenador não muda silenciosamente seus filhos.

Um perfil de referência fixo permite observar evolução do Sentinel. Comparações controladas de modelo/esforço são opcionais e adicionais: fixe source, fixture e demais atores. O relatório diferencia configuração solicitada de configuração realmente observada, e dados faltantes de zero.

## Recuperação e limites

```sh
npm run benchmark:resume -- --id meu-diagnostico --case import-1
```

Nunca repita `run` para recuperar uma execução incerta. A retomada verifica identidade, efeitos pendentes e prazo original; não reinicia orçamento, não duplica trabalho e pode recusar a continuação. Código novo não substitui um runtime com lease/lock ativo. `status`, `report` e `resume` usam o runtime existente sem upgrade automático. Uma interrupção incerta exige diagnóstico, não remoção de lock por conveniência.

O perfil registra limites por turno, tarefa, campanha, tokens observados e falta de progresso. Tokens em cache são subconjunto de input; reasoning é subconjunto de output. A coleta não estima cobrança e não garante um teto rígido de consumo em tempo real.

## Resultados e qualificação

- `benchmark-temp/benchmark-v2/evidence/campaigns/<id>/report.md`: relatório completo.
- `.../summary.json`: todas as células, incluindo falhas.
- `.../<tarefa>-<repetição>/`: resultado, configuração, ledger, autoridade, oracles e evidências.
- `benchmark-temp/benchmark-v2/launcher-logs/`: origem e hashes do código/fixture materializados.

Dados diagnósticos não são promovidos automaticamente a oficiais. O modo oficial exige certificado e preflight compatíveis; ainda não há qualificação oficial completa para esta versão empacotada. Veja [estado verificado e limites](bench/READINESS.md) e [contratos técnicos](bench/README.md).

O histórico anterior está em [`../legacy/sentinel-todo`](../legacy/sentinel-todo), separado da bancada nova e com proveniência. As rodadas da POC e da matriz diagnóstica permanecem privadas em `benchmark-temp`, sem entrar no histórico oficial nem no Git.
