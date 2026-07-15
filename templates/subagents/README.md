# `stnl-validation-runner`

Este agente copiável, barato e isolado executa checks e validação fora do contexto principal para as skills `stnl-slice-executor` e `stnl-slice-quality-manager`.

## Instalação

A cópia parte da pasta `templates/subagents/` deste repositório. Copie somente o adaptador da plataforma usada para a raiz do projeto:

- Codex: copie o conteúdo de `codex/`. O arquivo resultante deve ser `.codex/agents/stnl_validation_runner.toml`.
- Claude Code: copie o conteúdo de `claude-code/`. O arquivo resultante deve ser `.claude/agents/stnl-validation-runner.md`.

Não copie os dois adaptadores para o mesmo projeto. O Codex preserva `gpt-5.4-mini` com effort `medium`; o Claude Code preserva Haiku com effort `medium`.

## Fluxo manual e delegações automáticas

As operações manuais continuam `PLAN`, `REVIEW_PLAN`, `MATERIALIZE_TASKS`, `REVIEW_TASKS` opcional, `EXECUTE_SLICE`, `VALIDATE_SLICE`, `APPLY_FINDINGS` quando necessário e `CLOSE`. Não existe passo manual adicional de testes.

O runner aceita exatamente três operações internas, sempre acionadas automaticamente pelo launcher da operação manual:

- `EXECUTE_SLICE`: o contexto principal implementa; o runner executa checks e retorna `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`.
- `APPLY_FINDINGS`: o contexto principal corrige findings autorizados; o runner testa correções e regressões relacionadas e retorna `TESTS_PASS`, `TESTS_FAIL`, `TESTS_NOT_APPLICABLE` ou `BLOCKED`.
- `VALIDATE_SLICE`: o runner faz revisão e validação formal independentes e retorna `PASS`, `NEEDS_FIX` ou `BLOCKED`.

Descoberta de suites, comandos, logs, stack traces e resultados intermediários permanecem no contexto isolado. O contexto principal recebe somente evidência compacta e persiste a seção autorizada. Não existe fallback para executar checks ou validação no contexto principal.

Depois da implementação ou correção inicial, cada invocação manual válida de `EXECUTE_SLICE` ou `APPLY_FINDINGS` chama o runner no mínimo uma vez e no máximo três vezes: a primeira chamada é obrigatória e pode ser seguida por até duas rechecagens. Não existe bypass por mudança simples ou por provável ausência de checks; o runner sempre faz a descoberta independente, inclusive quando retorna `TESTS_NOT_APPLICABLE`. Em `TESTS_FAIL` nas duas primeiras rodadas, o contexto principal persiste a evidência, corrige somente a falha objetiva dentro do escopo aprovado, registra a correção e o escopo atualizado e chama o runner novamente. `TESTS_PASS`, `TESTS_NOT_APPLICABLE`, `BLOCKED`, a terceira falha ou uma decisão fora do escopo encerram o ciclo. Não existe quarta chamada, loop ilimitado, operação manual de retry nem transição automática para `VALIDATE_SLICE`.

Discovery actions são leituras e comandos read-only usados apenas para localizar scripts, CI, manifests, Makefiles, testes próximos, convenções e comandos autoritativos. Essas ações são permitidas, não contam como verification commands e são resumidas em `Check discovery sources`. Verification commands são testes, builds de verificação, linters, typechecks, compilações, validators, contract tests, smoke tests, regressões e outros checks observáveis da implementação ou correção.

`TESTS_PASS` confirma os verification commands selecionados com exit code zero. `TESTS_FAIL` representa verification command executado que falhou e pode sustentar uma correção limitada. `TESTS_NOT_APPLICABLE` representa somente descoberta objetiva de que nenhum verification command se aplica ao escopo e exige fontes e ações de descoberta, tipos considerados, justificativa e `No verification-command confirmation`; nenhum verification command pode ter sido executado. `BLOCKED` representa check aplicável impedido por ferramenta, credencial, dependência, ambiente, serviço, permissão ou comando autoritativo indisponível. Falha ou impossibilidade nunca é mascarada como não aplicabilidade.

A descoberta ocorre dentro da chamada automática ao runner; ela não cria um novo passo manual. O contexto principal continua sem executar checks e sem fallback.

## Launchers

As três operações que usam o runner possuem launcher específico por plataforma:

- Codex: `slice-execute-codex.md`, `slice-apply-findings-codex.md` e `slice-validate-codex.md`.
- Claude Code: `slice-execute-claude.md`, `slice-apply-findings-claude.md` e `slice-validate-claude.md`.

Copie somente os três launchers da plataforma usada. `execution-plan.md`, `execution-plan-review.md`, `execution-tasks.md`, `execution-tasks-review.md` e `execution-close.md` continuam compartilhados.

No Codex, os launchers fazem spawn do agente customizado `stnl_validation_runner`. No Claude Code, delegam diretamente a `@agent-stnl-validation-runner`. Os payloads internos incluem operação, SPEC path, execution root derivado, slice, paths de plans e tasks, evidências relevantes, escopo alterado e contexto adicional opcional, sem encaminhar logs completos.

## Test evidence e formal validation

Depois de cada chamada de `EXECUTE_SLICE`, o contexto principal adiciona um registro append-only em `Implementation Test Evidence`, com `implementation-check-NN` globalmente sequencial na seção e a rodada automática `N/3`. Depois de cada chamada de `APPLY_FINDINGS`, adiciona `findings-check-NN` nas mesmas condições em `Findings Test Evidence`, associado ao ciclo de findings. Uma invocação manual posterior continua a numeração. Cada registro preserva estado, comandos, exit codes, falhas, correções entre rodadas, arquivos, escopo, descoberta de checks, justificativa de não aplicabilidade e efeitos inesperados. Esses checks são evidência auxiliar: não criam Validation Attempt, não criam Effective Validation Base, não emitem `PASS` formal e não marcam a slice `[x]`.

Somente `VALIDATE_SLICE` cria uma Validation Attempt. O runner confere atualidade, autoridade, cobertura e risco das evidências anteriores e decide proporcionalmente quais checks executar ou repetir. Quando recebe `TESTS_NOT_APPLICABLE`, revisa independentemente a descoberta e a justificativa, podendo rejeitá-las, descobrir um check aplicável ou exigir inspeção adicional. Evidência atual pode reduzir repetição injustificada, mas nunca substitui a revisão independente. A validação formal continua aceitando somente `PASS`, `NEEDS_FIX` ou `BLOCKED`; não aplicabilidade auxiliar não garante `PASS`. Somente um `PASS` formal atual fornece o manifesto final completo, cria ou substitui a Effective Validation Base e permite a finalização automática da slice.

## Restrições

Os dois adaptadores implementam o mesmo contrato. O runner pode ler o escopo necessário e executar comandos, mas não edita código, testes, requisitos, planos ou tasks; não implementa, não corrige, não persiste, não finaliza, não cria subagentes e não faz commit. Artefatos transitórios normais de build ou teste são permitidos e efeitos inesperados no workspace são reportados.

`CLOSE` permanece read-only e não usa o runner, não executa testes, não faz retry nem aplica correções. Ele verifica conclusão, Effective Validation Bases, ownership final por path, hashes, remoções, reaparecimentos, paths sem owner e drift posterior ao último `PASS`. Uma necessidade global ou de integração deve existir como slice explícita do plano.
